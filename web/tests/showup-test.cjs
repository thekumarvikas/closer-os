// Show-up impact test: seeds a webinar with known patterns, checks the report, screenshots it.
const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; const PASS = 'Test-Pass-12345';
const log = (...a) => console.log('•', ...a);
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ids = []; let fails = 0;
const check = (l, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; log(l, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
const login = async e => { const c = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: PASS }); return c };

(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const owner = await mk('e2e-owner@closeros-test.dev', 'Vikas Kumar');
    const A = await mk('e2e-a@closeros-test.dev', 'Jaspreet'); const B = await mk('e2e-b@closeros-test.dev', 'Mahnoor');
    const oc = await login('e2e-owner@closeros-test.dev');
    const { data: orgId } = await oc.rpc('create_organization', { p_name: 'Kumar Coaching (TEST)' });
    await admin.from('org_members').insert([A, B].map(u => ({ org_id: orgId, user_id: u, role: 'rep' })));
    const webinarAt = new Date(Date.now() - 86400000);
    // Previous webinar (for the trend table)
    const mkBatch = async (name, at) => (await admin.from('batches').insert({ org_id: orgId, name, webinar_at: at.toISOString(), created_by: owner }).select().single()).data;
    const prev = await mkBatch('Webinar 27 Oct (TEST)', new Date(webinarAt.getTime() - 7 * 86400000));
    const batch = await mkBatch('Webinar 4 Oct (TEST)', webinarAt);
    const { data: cats } = await admin.from('profession_categories').select('id,name').eq('org_id', orgId);
    const { data: outs } = await admin.from('call_outcomes').select('id,code').eq('org_id', orgId);
    const O = c => outs.find(o => o.code === c).id;

    const leads = []; for (let i = 0; i < 400; i++) leads.push({ org_id: orgId, name: `Lead ${i}`, phone: `+9198${String(20000000 + i)}`, assigned_to: i % 2 ? A : B,
      profession: ['CA', 'SEO', 'Teacher', 'Shop owner'][i % 4], source: i % 3 ? 'Facebook' : 'Google' });
    const { data: L } = await admin.from('leads').insert(leads).select('id,assigned_to');
    const exp = { called: { leads: 0, joined: 0 }, not: { leads: 0, joined: 0 }, A: { leads: 0, joined: 0 }, B: { leads: 0, joined: 0 }, guided: { leads: 0, joined: 0 }, dnp: { leads: 0, joined: 0 }, lt3h: { leads: 0, joined: 0 } };
    const bl = [], calls = [];
    L.forEach((l, i) => {
      const caller = l.assigned_to; const isA = caller === A;
      const notCalled = i % 10 === 0;
      const late = i % 3 === 0; // last call within 3 hours
      const answered = !notCalled && rnd() < (isA ? 0.8 : 0.5);
      const pJoin = notCalled ? 0.1 : answered ? (late ? 0.75 : 0.45) : 0.15;
      const joined = rnd() < pJoin; const minutes = joined ? (rnd() < 0.5 ? 70 : 20) : 0;
      bl.push({ batch_id: batch.id, lead_id: l.id, org_id: orgId, reminder_by: caller, watch_minutes: minutes, attended: joined, added_at: new Date(webinarAt.getTime() - (i % 5 + 0.5) * 86400000).toISOString() });
      bl.push({ batch_id: prev.id, lead_id: l.id, org_id: orgId, reminder_by: caller, watch_minutes: rnd() < (isA ? 0.4 : 0.25) ? 30 : 0, attended: false, added_at: prev.webinar_at });
      const k = isA ? 'A' : 'B'; exp[k].leads++; if (joined) exp[k].joined++;
      if (notCalled) { exp.not.leads++; if (joined) exp.not.joined++; return }
      exp.called.leads++; if (joined) exp.called.joined++;
      const at = new Date(webinarAt.getTime() - (late ? 2 : 30) * 3600000);
      calls.push({ id: crypto.randomUUID(), org_id: orgId, user_id: caller, lead_id: l.id, direction: 'outgoing', phone: '+9198' + (20000000 + i), started_at: at.toISOString(),
        duration_sec: answered ? 90 : 0, outcome_id: answered ? O('r_guided') : O('r_didnt_pick'), purpose: 'reminder', batch_id: batch.id });
      calls.push({ id: crypto.randomUUID(), org_id: orgId, user_id: caller, lead_id: l.id, direction: 'outgoing', phone: '+9198' + (20000000 + i), started_at: new Date(prev.webinar_at).toISOString(),
        duration_sec: 30, purpose: 'reminder', batch_id: prev.id });
      const g = answered ? 'guided' : 'dnp'; exp[g].leads++; if (joined) exp[g].joined++;
      if (late) { exp.lt3h.leads++; if (joined) exp.lt3h.joined++ }
    });
    { const { error } = await admin.from('batch_leads').insert(bl); if (error) throw error }
    for (let i = 0; i < calls.length; i += 500) { const { error } = await admin.from('calls').insert(calls.slice(i, i + 500)); if (error) throw error }
    await admin.from('batches').update({ zoom_uploaded_at: new Date().toISOString() }).in('id', [batch.id, prev.id]);

    const { data: rep, error: re } = await oc.rpc('show_up_report', { p_batch: batch.id }); if (re) throw re;
    const t = g => { const x = rep.by_caller.find(r => r.g === 1 && r.grp === g); return { leads: x.leads, joined: x.joined } };
    check('called', t('called'), exp.called); check('not called', t('not_called'), exp.not);
    const c = u => rep.by_caller.filter(r => r.g === 0 && r.caller === u).reduce((s, r) => ({ leads: s.leads + r.leads, joined: s.joined + r.joined }), { leads: 0, joined: 0 });
    check('caller A', c(A), exp.A); check('caller B', c(B), exp.B);
    const o = id => { const x = rep.by_outcome.find(r => r.g === 1 && r.outcome === id); return { leads: x.leads, joined: x.joined } };
    check('guided', o(O('r_guided')), exp.guided); check("didn't pick", o(O('r_didnt_pick')), exp.dnp);
    const p = rep.patterns.find(x => x.dim === 'timing' && x.bucket === 'a_lt3h'); check('called within 3h', { leads: p.leads, joined: p.joined }, exp.lt3h);
    // A rep sees only their own row.
    const a = await login('e2e-a@closeros-test.dev'); const { data: ar } = await a.rpc('show_up_report', { p_batch: batch.id });
    check('rep A sees only self', [...new Set(ar.by_caller.filter(r => r.g === 0).map(r => r.caller))], [A]);
    // Test group: 10% → ~40 leads marked, assign_reminders skips them.
    const t2 = await mkBatch('Webinar next (TEST)', new Date(Date.now() + 3 * 86400000));
    { const { error } = await admin.from('batch_leads').insert(L.map(l => ({ batch_id: t2.id, lead_id: l.id, org_id: orgId }))); if (error) throw error }
    await oc.from('batches').update({ holdout_pct: 10 }).eq('id', t2.id);
    const { count: ho } = await admin.from('batch_leads').select('*', { count: 'exact', head: true }).eq('batch_id', t2.id).eq('is_holdout', true);
    check('test group size (10% of 400)', ho, 40);
    const { data: n } = await oc.rpc('assign_reminders', { p_batch: t2.id, p_user_ids: [A, B] });
    check('reminders assigned skip test group', n, 360);
    await oc.from('batches').update({ holdout_pct: 0 }).eq('id', t2.id);
    const { count: ho0 } = await admin.from('batch_leads').select('*', { count: 'exact', head: true }).eq('batch_id', t2.id).eq('is_holdout', true);
    check('test group off again', ho0, 0);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = []; const pg = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    pg.on('pageerror', e => errors.push(e.message));
    await pg.goto('http://localhost:4173/'); await pg.fill('input[type=email]', 'e2e-owner@closeros-test.dev'); await pg.fill('input[type=password]', PASS); await pg.click('button[type=submit]');
    await pg.waitForSelector('nav >> text=Webinars'); await pg.goto(`http://localhost:4173/webinars/${batch.id}`);
    await pg.getByRole('button', { name: 'Show-up impact' }).click(); await pg.waitForSelector('text=What stands out', { timeout: 20000 }); await pg.waitForTimeout(1000);
    await pg.screenshot({ path: `${SHOTS}/1-showup.png`, fullPage: true });
    log('findings:', (await pg.locator('ul.space-y-2 li').allInnerTexts()).join(' / '));
    await pg.getByRole('button', { name: /Stayed 60\+ min/ }).first().click(); await pg.waitForTimeout(500);
    await pg.screenshot({ path: `${SHOTS}/2-stayed.png`, fullPage: true });
    await pg.click('svg.lucide-pencil >> xpath=..'); await pg.waitForSelector('text=Test group (optional)'); await pg.screenshot({ path: `${SHOTS}/3-form.png` });
    log('page errors:', errors.length ? errors : 'none');
    await browser.close();
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const x of orgs ?? []) await admin.from('organizations').delete().eq('id', x.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    log('cleaned up', fails ? `— ${fails} CHECKS FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
