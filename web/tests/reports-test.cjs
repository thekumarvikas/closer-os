const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const OWNER = { email: 'e2e-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const reps = ['Jaspreet Kaur', 'Maria D\'Souza', 'Naina Prasad', 'Uzma Khan'];
const log = (...a) => console.log('•', ...a);
let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ids = [];

(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test-Pass-12345', email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const owner = await mk(OWNER.email, 'Vikas Kumar'); await admin.auth.admin.updateUserById(owner, { password: OWNER.password });
    const repIds = []; for (let i = 0; i < reps.length; i++) repIds.push(await mk(`e2e-rep${i}@closeros-test.dev`, reps[i]));
    const { data: org, error: oe } = await admin.from('organizations').insert({ name: 'Kumar Coaching (TEST)', created_by: owner }).select().single(); if (oe) throw oe;
    await admin.from('org_members').insert([{ org_id: org.id, user_id: owner, role: 'owner' }, ...repIds.map(u => ({ org_id: org.id, user_id: u, role: 'rep' }))]);
    // default outcomes like create_organization
    const outs = [['no_answer','No Answer','not_connected'],['interested','Interested','positive'],['follow_up','Follow-up Required','connected'],['not_interested','Connected – Not Interested','lost'],['sale_closed','Sale Closed','won']];
    const { data: oc } = await admin.from('call_outcomes').insert(outs.map(([code,label,category],i)=>({org_id:org.id,code,label,category,position:i}))).select();
    const leads = []; for (let i = 0; i < 400; i++) leads.push({ org_id: org.id, name: `Lead ${i + 1}`, phone: `+9198${String(70000000 + i).padStart(8, '0')}`, assigned_to: repIds[i % 4], source: i % 3 ? 'Facebook' : 'Webinar' });
    const { data: L, error: le } = await admin.from('leads').insert(leads).select('id,phone,assigned_to'); if (le) throw le;
    const calls = []; const now = Date.now();
    for (let d = 29; d >= 0; d--) {
      const dayStart = new Date(new Date(now - d * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T10:00:00+05:30').getTime();
      repIds.forEach((u, ri) => {
        const n = 40 + Math.floor(rnd() * 40) + ri * 10;
        let t = dayStart + rnd() * 1800000;
        for (let k = 0; k < n; k++) {
          if (t > now) break;
          const x = rnd(); const dir = x < 0.84 ? 'outgoing' : x < 0.93 ? 'incoming' : x < 0.98 ? 'missed' : 'rejected';
          const toLead = rnd() < 0.7; const lead = toLead ? L.filter(l => l.assigned_to === u)[Math.floor(rnd() * 100)] : null;
          const hr = new Date(t).getUTCHours() + 5.5; const rate = hr >= 17 ? 0.5 : hr < 12 ? 0.3 : 0.38;
          const conn = (dir === 'incoming') || (dir === 'outgoing' && rnd() < rate);
          const dur = conn ? Math.round(20 + rnd() * rnd() * 600) : 0;
          calls.push({ id: crypto.randomUUID(), org_id: org.id, user_id: u, lead_id: lead?.id ?? null, direction: dir,
            phone: lead?.phone ?? `+9199${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`, started_at: new Date(t).toISOString(), duration_sec: dur,
            outcome_id: lead && conn ? oc[1 + Math.floor(rnd() * 4)].id : lead ? oc[0].id : null, sim_slot: 1, sim_label: 'Jio',
            recording_status: conn ? (rnd() < 0.9 ? 'uploaded' : 'missing') : 'not_expected', outcome_data: {} });
          t += (dur + 30 + rnd() * 300) * 1000;
        }
      });
    }
    for (let i = 0; i < calls.length; i += 1000) { const { error } = await admin.from('calls').insert(calls.slice(i, i + 1000)); if (error) throw error; }
    log('seeded', calls.length, 'calls,', L.length, 'leads');

    // Check numbers against a direct count (as the owner, through the report function).
    const user = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } });
    await user.auth.signInWithPassword(OWNER);
    const from = new Date(now - 31 * 86400000), to = new Date(now + 86400000);
    const t0 = Date.now(); const { data: rep, error: re } = await user.rpc('call_report', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString() }); if (re) throw re;
    const total = rep.rows.find(x => x.g === 15);
    const expect = { calls: calls.length, conn: calls.filter(c => ['incoming','outgoing'].includes(c.direction) && c.duration_sec > 0).length,
      missed: calls.filter(c => c.direction === 'missed').length, not_picked: calls.filter(c => c.direction === 'outgoing' && !c.duration_sec).length,
      dur: calls.reduce((s, c) => s + c.duration_sec, 0), uniq: new Set(calls.map(c => c.phone)).size };
    log(`report took ${Date.now() - t0} ms`);
    for (const k of Object.keys(expect)) log(k, 'report =', total[k], 'expected =', expect[k], total[k] === expect[k] ? 'OK' : 'MISMATCH');
    // A rep must only see their own calls.
    const repC = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } });
    await repC.auth.signInWithPassword({ email: 'e2e-rep0@closeros-test.dev', password: 'Test-Pass-12345' });
    const { data: rr } = await repC.rpc('call_report', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString() });
    log('rep0 sees', rr.rows.find(x => x.g === 15).calls, 'calls; own calls =', calls.filter(c => c.user_id === repIds[0]).length);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', OWNER.email); await p.fill('input[type=password]', OWNER.password); await p.click('button[type=submit]');
    await p.waitForSelector('text=Last 7 days'); await p.waitForTimeout(1500);
    await p.screenshot({ path: `${SHOTS}/1-dashboard.png`, fullPage: true });
    await p.click('nav >> text=Reports'); await p.click('button:has-text("This month")');
    await p.click('button:has-text("Last 7 days")'); try { await p.waitForSelector('text=Calls by type', { timeout: 20000 }) } catch (e) { await p.screenshot({ path: `${SHOTS}/fail.png` }); console.log('ERRORS', errors); throw e } await p.waitForTimeout(800);
    await p.screenshot({ path: `${SHOTS}/2-summary.png`, fullPage: true });
    for (const [tab, file] of [['Employees', '3-employees'], ['Day-wise', '4-daywise'], ['Hourly', '5-hourly'], ['Call history', '6-history']]) {
      await p.getByRole('button', { name: tab, exact: true }).click(); await p.waitForTimeout(1500); await p.screenshot({ path: `${SHOTS}/${file}.png`, fullPage: tab !== 'Call history' });
    }
    await p.getByRole('button', { name: 'Day-wise', exact: true }).click(); await p.getByLabel('Split by employee').check(); await p.waitForTimeout(500);
    await p.screenshot({ path: `${SHOTS}/7-daywise-split.png` });
    await p.getByRole('button', { name: 'Call history', exact: true }).click(); await p.fill('input[placeholder="Search lead name or phone"]', 'Lead 12'); await p.waitForSelector('tbody tr, :text("No calls match")', { timeout: 15000 }); await p.waitForTimeout(300); await p.screenshot({ path: `${SHOTS}/9-history-search.png` });
    log('history search rows:', await p.locator('tbody tr').count());
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export CSV")')]);
    log('export file:', dl.suggestedFilename());
    const m = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await m.goto('http://localhost:4173/'); await m.fill('input[type=email]', OWNER.email); await m.fill('input[type=password]', OWNER.password); await m.click('button[type=submit]');
    await m.waitForSelector('text=Last 7 days'); await m.waitForTimeout(1500); await m.screenshot({ path: `${SHOTS}/8-mobile.png` });
    log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
    await browser.close();
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const x of orgs ?? []) await admin.from('organizations').delete().eq('id', x.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    log('cleaned up');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
