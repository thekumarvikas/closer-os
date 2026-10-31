const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; const PASS = 'Test-Pass-12345'; const ids = []; let fails = 0;
const check = (l, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log('•', l, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
const login = async e => { const c = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: PASS }); return c };
const min = m => new Date(Date.now() + m * 60000).toISOString();
(async () => {
  try {
    const mk = async (e, n) => { const { data } = await admin.auth.admin.createUser({ email: e, password: PASS, email_confirm: true, user_metadata: { full_name: n } }); ids.push(data.user.id); return data.user.id };
    const owner = await mk('e2e-owner@closeros-test.dev', 'Vikas Kumar'); const rep = await mk('e2e-rep@closeros-test.dev', 'Ankit Singh');
    const oc = await login('e2e-owner@closeros-test.dev'); const { data: org } = await oc.rpc('create_organization', { p_name: 'Feedback (TEST)' });
    await admin.from('org_members').insert({ org_id: org, user_id: rep, role: 'rep' });
    const rc = await login('e2e-rep@closeros-test.dev');
    // Phone numbers
    let e = (await rc.rpc('set_member_phone', { p_org: org, p_user: rep, p_phone: '98111 22233' })).error; check('rep sets own phone', e, null);
    e = (await rc.rpc('set_member_phone', { p_org: org, p_user: owner, p_phone: '9000000000' })).error; check('rep cannot set owner phone', !!e, true);
    e = (await oc.rpc('set_member_phone', { p_org: org, p_user: owner, p_phone: '9000011111' })).error; check('admin sets phone', e, null);
    const { data: pr } = await oc.from('profiles').select('phone').eq('id', rep).single(); check('phone normalised', pr.phone, '+919811122233');
    // Follow-up discipline: 3 leads, follow-ups due 60 min ago
    const { data: L } = await admin.from('leads').insert([1, 2, 3].map(i => ({ org_id: org, name: `FU ${i}`, phone: `+91980000000${i}`, assigned_to: rep }))).select();
    await admin.from('follow_ups').insert(L.map(l => ({ org_id: org, lead_id: l.id, assigned_to: rep, due_at: min(-60) })));
    const sync = (lead, at) => rc.rpc('sync_calls', { p_org: org, p_calls: [{ id: crypto.randomUUID(), phone: lead.phone, direction: 'outgoing', started_at: at, duration_sec: 40, sim_number: '9811122233', sim_slot: 1 }] });
    await sync(L[0], min(-55));   // 5 min after due → on time
    await sync(L[1], min(-30));   // 30 min after due → late
    const { data: fr } = await oc.rpc('follow_up_report', { p_org: org, p_from: min(-120), p_to: min(10) });
    const t = fr.find(x => x.g === 1);
    check('follow-ups on time / late / not called', [t.on_time, t.late, t.missed], [1, 1, 1]);
    const { data: c1 } = await admin.from('calls').select('sim_number').eq('org_id', org).limit(1).single(); check('SIM number saved on call', c1.sim_number, '+919811122233');
    // Unknown number becomes a lead later → earlier call links to it
    await rc.rpc('sync_calls', { p_org: org, p_calls: [{ id: crypto.randomUUID(), phone: '9555500000', direction: 'incoming', started_at: min(-5), duration_sec: 20 }] });
    const { data: nl } = await rc.from('leads').insert({ org_id: org, name: 'From call log', phone: '9555500000' }).select().single();
    const { count: linked } = await admin.from('calls').select('*', { count: 'exact', head: true }).eq('lead_id', nl.id); check('earlier call linked to new lead', linked, 1);
    check('lead added by rep is assigned to rep', nl.assigned_to, rep);
    // Batch compare
    await oc.from('batches').insert({ org_id: org, name: 'Event A (TEST)', kind: 'event', webinar_at: min(60 * 24) });
    const { data: cmp, error: ce } = await oc.rpc('batch_compare', { p_org: org }); check('compare works', [ce, cmp.length, cmp[0].kind], [null, 1, 'event']);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = []; const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', x => errors.push(x.message));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'e2e-owner@closeros-test.dev'); await p.fill('input[type=password]', PASS); await p.click('button[type=submit]');
    await p.waitForSelector('td:has-text("Conversation")', { timeout: 30000 }); await p.waitForTimeout(800); await p.screenshot({ path: `${SHOTS}/1-dashboard.png`, fullPage: true });
    await p.click('nav >> text=Reports'); await p.getByRole('button', { name: 'Team', exact: true }).click(); await p.waitForSelector('th:has-text("Person")', { timeout: 30000 }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/2-team.png` });
    await p.getByRole('button', { name: 'Follow-ups', exact: true }).click(); await p.waitForSelector('text=Late (15+ min)'); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/3-fu-discipline.png` });
    await p.click('nav >> text=Calls'); await p.waitForSelector('th:has-text("Dialled from")', { timeout: 30000 }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/4-calls.png` });
    await p.click('nav >> text=Follow-ups'); await p.getByRole('button', { name: /^Late/ }).click(); await p.waitForSelector('text=Not called', { timeout: 30000 }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/5-followups-late.png` });
    await p.click('nav >> text=Events & Batches'); await p.click('button:has-text("Compare results")'); await p.waitForSelector('text=Event A', { timeout: 30000 }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/6-compare.png` });
    await p.click('nav >> text=Team'); await p.waitForSelector('text=Ankit Singh', { timeout: 30000 }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/7-team-page.png` });
    await p.click('nav >> text=Reports'); await p.getByRole('button', { name: 'Call log', exact: true }).click(); await p.waitForSelector('th:has-text("Dialled from")', { timeout: 30000 }); await p.waitForTimeout(2500);
    check('call log tab stays loaded', await p.locator('text=Loading').count(), 0);
    console.log('• page errors:', errors.length ? errors : 'none');
    await browser.close();
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const o of orgs ?? []) await admin.from('organizations').delete().eq('id', o.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log('• cleaned up', fails ? `— ${fails} FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1) });
