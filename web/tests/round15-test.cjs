// Round 15: webinar page — Everyone / Registered / Joined-without-registering switch, show-up by call result (30-second rule),
// every number opens its lead list (scroll, CSV, lead details), poll-file check. Seeds a temporary company with known numbers,
// checks them in the browser, takes screenshots, then deletes everything. Same env vars as e2e.cjs.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const OWNER = { email: 'r15-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const log = (...a) => console.log('•', ...a);
const ids = []; let orgId = null; let fails = 0;
const check = (ok, what) => { if (!ok) fails++; log(ok ? 'OK  ' : 'FAIL', what) };

(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test-Pass-12345', email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const owner = await mk(OWNER.email, 'Vikas Kumar'); await admin.auth.admin.updateUserById(owner, { password: OWNER.password });
    const rep = await mk('r15-rep@closeros-test.dev', 'Priya Sharma');
    const { data: org, error: oe } = await admin.from('organizations').insert({ name: 'Webinar Co (TEST)', created_by: owner }).select().single(); if (oe) throw oe;
    orgId = org.id;
    await admin.from('org_members').insert([{ org_id: org.id, user_id: owner, role: 'owner' }, { org_id: org.id, user_id: rep, role: 'rep' }]);
    // New companies get the standard outcome list; use a positive and a not-connected reminder outcome from it.
    let { data: all } = await admin.from('call_outcomes').select('id, code, category, purpose').eq('org_id', org.id);
    if (!all?.length) { await admin.from('call_outcomes').insert([['r_guided', 'Guided', 'positive'], ['r_didnt_pick', "Didn't pick", 'not_connected']]
      .map(([code, label, category], i) => ({ org_id: org.id, code, label, category, position: i, purpose: 'reminder' }))); ({ data: all } = await admin.from('call_outcomes').select('id, code, category, purpose').eq('org_id', org.id)) }
    const oc = [all.find(o => o.category === 'positive') ?? all[0], all.find(o => o.category === 'not_connected') ?? all[0]];
    const at = new Date(Date.now() - 2 * 86400000);
    const { data: b } = await admin.from('batches').insert({ org_id: org.id, name: 'Primavera TEST', webinar_at: at.toISOString(), created_by: owner, hot_minutes: 60 }).select().single();

    // 40 registered (20 joined, 8 of them 60+ min), 10 walk-ins (all joined, 6 of them 60+ min).
    const leads = []; for (let i = 0; i < 50; i++) leads.push({ org_id: org.id, name: `Lead ${100 + i}`, phone: `+9199${String(55000000 + i).padStart(8, '0')}`, assigned_to: rep,
      source: i < 40 ? 'Fb Advts' : 'Zoom attendee', profession: i % 3 ? 'Civil engineer' : 'Student' });
    const { data: L, error: le } = await admin.from('leads').insert(leads).select('id,phone'); if (le) throw le;
    const bl = L.map((l, i) => {
      const reg = i < 40; const w = reg ? (i < 20 ? (i < 8 ? 75 : 20) : 0) : (i < 46 ? 90 : 30);
      return { batch_id: b.id, lead_id: l.id, org_id: org.id, registered: reg, watch_minutes: w, attended: w > 0, reminder_by: rep }
    });
    const { error: be } = await admin.from('batch_leads').insert(bl); if (be) throw be;
    await admin.from('batches').update({ zoom_uploaded_at: new Date().toISOString() }).eq('id', b.id);
    // Reminder calls before the webinar: leads 0–14 spoke 30+ s (10 of them joined), 15–24 dialled < 30 s, the rest never dialled.
    const calls = [];
    L.slice(0, 25).forEach((l, i) => calls.push({ id: crypto.randomUUID(), org_id: org.id, user_id: rep, lead_id: l.id, phone: l.phone, direction: 'outgoing',
      started_at: new Date(at.getTime() - 5 * 3600000).toISOString(), duration_sec: i < 15 ? 95 : 12, outcome_id: i < 15 ? oc[0].id : oc[1].id, outcome_data: {},
      purpose: 'reminder', batch_id: b.id, sim_slot: 1 }));
    const { error: ce } = await admin.from('calls').insert(calls); if (ce) throw ce;
    log('seeded 40 registered + 10 walk-ins, 25 reminder calls');

    // Numbers straight from the database first.
    const ownerC = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } });
    await ownerC.auth.signInWithPassword(OWNER);
    const { data: rep0 } = await ownerC.rpc('show_up_report', { p_batch: b.id, p_scope: 'all' });
    const g = k => rep0.by_call.find(x => x.grp === k) ?? { leads: 0, joined: 0 };
    check(g('connected').leads === 15 && g('not_connected').leads === 10 && g('not_dialled').leads === 25, `call groups 15/10/25 → ${g('connected').leads}/${g('not_connected').leads}/${g('not_dialled').leads}`);
    const reg = rep0.groups.find(x => x.registered), walk = rep0.groups.find(x => !x.registered);
    check(reg.leads === 40 && reg.joined === 20 && walk.leads === 10 && walk.joined === 10, `groups registered 40/20, walk-in 10/10 → ${reg.leads}/${reg.joined}, ${walk.leads}/${walk.joined}`);
    check(!rep0.patterns.some(p => p.dim === 'source' && p.bucket === 'Zoom attendee'), 'no "Zoom attendee" in patterns');
    const { data: list } = await ownerC.rpc('show_up_leads', { p_batch: b.id, p_scope: 'all', p_filter: { grp: 'connected', joined: true } });
    check(list.length === g('connected').joined, `list behind "spoke to them, joined" = ${list.length}`);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
    p.setDefaultTimeout(20000); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', OWNER.email); await p.fill('input[type=password]', OWNER.password); await p.click('button[type=submit]');
    await p.waitForTimeout(3000);
    const shot = async n => { await p.waitForTimeout(1500); await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); log('screenshot', n) };

    await p.goto(`http://localhost:4173/webinars/${b.id}`); await p.waitForSelector('text=Showing');
    await p.click('button:has-text("Show-up impact")'); await p.waitForSelector('text=Show-up by reminder call'); await shot('1-showup-everyone');
    await p.click('button:has-text("Registered, and joined")'); await p.waitForSelector('text=20 leads'); await shot('2-drill-registered-joined');
    check(await p.locator('button:has-text("CSV")').count() > 0, 'list has a CSV button');
    await p.locator('.fixed tbody tr').first().click(); await p.waitForTimeout(2500); await shot('3-lead-from-list');
    await p.keyboard.press('Escape'); await p.goto(`http://localhost:4173/webinars/${b.id}`); await p.waitForSelector('text=Showing');
    await p.click('button:has-text("Show-up impact")'); await p.waitForSelector('text=Show-up by reminder call');
    await p.click('button:has-text("Joined without registering (10)")'); await p.waitForTimeout(1500); await shot('4-showup-walkins');
    await p.click('button:has-text("Registered (40)")'); await p.waitForTimeout(1500); await shot('5-showup-registered');
    await p.click('button:has-text("Everyone (50)")');
    await p.click('button:has-text("Reminder calls (before)")'); await p.waitForSelector('text=Lead quality by profession'); await shot('6-reminder-tab');
    await p.click('button:has-text("Student")'); await p.waitForSelector('text=Profession: Student'); await shot('7-profession-list');
    const studentRows = await p.locator('.fixed tbody tr').count();
    check(studentRows === 17, `Student list has 17 leads → ${studentRows}`);
    await p.goto(`http://localhost:4173/webinars/${b.id}`); await p.waitForSelector('text=Showing');
    await p.click('button:has-text("Sales calls (after)")'); await p.waitForSelector('text=By team member'); await shot('8-sales-tab');

    // Poll check: the owner's notes file (long sentences, no real emails) must be stopped with the reason.
    const bad = 'Name,Email,Notes\n' + Array.from({ length: 8 }, (_, i) => `Person ${i},a${i} ***,"13 waiting-room rows and 2 host rows removed from 995 raw rows. 401 rows remained after cleaning and matching; Zoom email is the strongest key here ${i}"`).join('\n');
    const badFile = `${SHOTS}/bad-polls.csv`; fs.writeFileSync(badFile, bad);
    await p.click('button:has-text("Upload polls")'); await p.setInputFiles('input[type=file]', badFile);
    await p.waitForSelector("text=This doesn't look like a Zoom poll report"); await shot('9-bad-polls');
    check(await p.getByRole('button', { name: /^Save \d+ answers/ }).isDisabled(), 'Save is blocked for a non-poll file');

    // Team performance: sortable, three views, numbers open their leads.
    await p.keyboard.press('Escape');
    await p.goto('http://localhost:4173/reports'); await p.click('button:has-text("Team performance")'); await p.waitForSelector('text=Activity & results'); await shot('10-team-results');
    await p.click('button:has-text("CRM hygiene")'); await p.waitForSelector('text=Marks (of 100)'); await shot('11-team-hygiene');
    await p.click('button:has-text("Reminder show-up")'); await p.waitForSelector('text=Show-up of those spoken to'); await shot('12-team-reminder');
    const regCell = p.locator('tbody tr td:nth-child(2) button').first();
    if (await regCell.count()) { await regCell.click(); await p.waitForSelector('.fixed tbody tr'); await shot('13-team-drill'); check(await p.locator('.fixed tbody tr').count() === 40, 'reminder registrants list = 40') }
    log('browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++;
    await browser.close();
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    log(fails ? `${fails} problem(s)` : 'all checks passed', '· cleaned up')
  }
})();
