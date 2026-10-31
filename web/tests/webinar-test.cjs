// End-to-end test of webinar batches: import into batch (with repeats), buyers, reminder assignment,
// Zoom report matching, reminder + sales calls, and the batch report numbers.
const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const PASS = 'Test-Pass-12345';
const log = (...a) => console.log('•', ...a);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ids = []; let fails = 0;
const check = (label, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; log(label, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
const client = async email => { const c = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email, password: PASS }); if (error) throw error; return c };

(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const owner = await mk('e2e-owner@closeros-test.dev', 'Vikas Kumar');
    const reps = [await mk('e2e-r1@closeros-test.dev', 'Ankit Singh'), await mk('e2e-r2@closeros-test.dev', 'Sachin Upadhyay'), await mk('e2e-r3@closeros-test.dev', 'Rajni Bhati')];
    const caller = await mk('e2e-rc@closeros-test.dev', 'Asia Reminder');
    const oc = await client('e2e-owner@closeros-test.dev');
    const { data: orgId, error: ce } = await oc.rpc('create_organization', { p_name: 'Kumar Coaching (TEST)' }); if (ce) throw ce;
    await admin.from('org_members').insert([...reps, caller].map(u => ({ org_id: orgId, user_id: u, role: 'rep' })));
    await admin.from('distribution_rules').insert({ org_id: orgId, name: 'RR', method: 'round_robin', user_ids: reps });
    // 40 people who were leads before (to test "Repeated").
    const old = Array.from({ length: 40 }, (_, i) => ({ org_id: orgId, name: `Old Lead ${i}`, phone: `+9197000${String(i).padStart(5, '0')}`, email: `old${i}@mail.test`, assigned_to: reps[i % 3] }));
    await admin.from('leads').insert(old);

    // Registration file: 260 new + 40 existing numbers (+ 1 duplicate row, 1 bad number).
    const regs = [];
    for (let i = 0; i < 260; i++) regs.push({ name: `Reg ${i}`, phone: `98${String(10000000 + i)}`, email: `reg${i}@mail.test`, profession: ['CA', 'Insurance agent', 'SEO freelancer', 'Teacher', 'Shop owner', 'Cab driver'][i % 6] });
    for (let i = 0; i < 40; i++) regs.push({ name: `Old Lead ${i}`, phone: `97000${String(i).padStart(5, '0')}`, email: `old${i}@mail.test`, profession: '' });
    regs.push({ ...regs[0] }); regs.push({ name: 'Bad', phone: '123', email: '', profession: '' });
    fs.writeFileSync(`${SHOTS}/registrations.csv`, 'Name,Mobile Number,Email,Profession\n' + regs.map(x => `${x.name},${x.phone},${x.email},${x.profession}`).join('\n'));
    // Buyers: 5 old leads bought before (previous batch enrolled).
    fs.writeFileSync(`${SHOTS}/buyers.csv`, 'Name,Phone,Course,Purchase Date,Amount\n' + [0, 1, 2, 3, 4].map(i => `Old Lead ${i},97000${String(i).padStart(5, '0')},Business Mastery,15/08/2026,24999`).join('\n'));

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'e2e-owner@closeros-test.dev'); await p.fill('input[type=password]', PASS); await p.click('button[type=submit]');
    await p.waitForSelector('nav >> text=Webinars');

    // Buyers upload (Settings)
    await p.click('nav >> text=Settings'); await p.click('button:has-text("Upload buyers")');
    await p.setInputFiles('input[type=file]', `${SHOTS}/buyers.csv`); await p.click('button:has-text("Upload 5 buyers")');
    await p.waitForSelector('text=buyers added'); await p.click('button:has-text("Done")');
    await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/1-settings.png`, fullPage: true });

    // New webinar, 2 days ago
    await p.click('nav >> text=Webinars'); await p.click('button:has-text("New webinar")');
    await p.fill('input[placeholder="e.g. Webinar 4 Oct 2026"]', 'Webinar 4 Oct (TEST)');
    const d = new Date(Date.now() - 2 * 86400000); const ist = new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    await p.fill('input[type=datetime-local]', `${ist}T19:00`); await p.click('button:has-text("Save")');
    await p.click('text=Webinar 4 Oct (TEST)'); await p.waitForSelector('text=Add registrations');
    const batchId = p.url().split('/').pop();

    // Import registrations into the batch
    await p.click('button:has-text("Add registrations")'); await p.setInputFiles('input[type=file]', `${SHOTS}/registrations.csv`);
    await p.waitForSelector('text=Match your columns'); await p.click('button:has-text("Import 302 leads")');
    await p.waitForSelector('text=leads imported');
    log('import:', (await p.locator('.py-6.text-center').innerText()).replace(/\n/g, ' | '));
    await p.click('button:has-text("Done")');

    // Reminder calls all go to the reminder caller
    await p.click('button:has-text("Assign reminder calls")'); await p.check('label:has-text("Asia Reminder") input'); await p.click('button:has-text("Assign"):not(:has-text("reminder"))');
    await p.waitForSelector('text=now have a reminder caller'); await p.click('button:has-text("Done")');

    // Zoom report: 150 by email, 30 by phone only, 20 new people; some people joined twice.
    const zoom = []; const watch = new Map();
    for (let i = 0; i < 150; i++) { const m = 5 + Math.floor(rnd() * 110); watch.set(`+9198${10000000 + i}`, m); if (i % 10 === 0) { zoom.push([`Reg ${i}`, `reg${i}@mail.test`, '', Math.floor(m / 2)]); zoom.push([`Reg ${i}`, `reg${i}@mail.test`, '', m - Math.floor(m / 2)]) } else zoom.push([`Reg ${i}`, `reg${i}@mail.test`, '', m]) }
    for (let i = 150; i < 180; i++) { const m = 5 + Math.floor(rnd() * 110); watch.set(`+9198${10000000 + i}`, m); zoom.push([`Reg ${i}`, `other${i}@gmail.test`, `+91 98${10000000 + i}`, m]) }
    for (let i = 0; i < 20; i++) zoom.push([`New Person ${i}`, `new${i}@mail.test`, `96000${String(i).padStart(5, '0')}`, 30 + i]);
    const zcsv = ['Attendee Report', 'Report Generated:,"10/04/2026 21:00"', 'Topic,Webinar ID', 'Webinar 4 Oct,123', '', 'Host Details',
      'Attended,User Name (Original Name),Email,Join Time,Leave Time,Time in Session (minutes)', 'Yes,Host,host@x.test,,,120', '', 'Attendee Details',
      'Attended,User Name (Original Name),First Name,Last Name,Email,Phone,Registration Time,Join Time,Leave Time,Time in Session (minutes),Is Guest',
      ...zoom.map(([n, e, ph, m]) => `Yes,${n},${n.split(' ')[0]},${n.split(' ')[1]},${e},${ph},,,,${m},No`)].join('\n');
    fs.writeFileSync(`${SHOTS}/zoom.csv`, zcsv);
    await p.click('button:has-text("Upload Zoom report")'); await p.setInputFiles('input[type=file]', `${SHOTS}/zoom.csv`);
    await p.waitForSelector('text=different people'); await p.screenshot({ path: `${SHOTS}/2-zoom-columns.png` });
    await p.click('button:has-text("Match 200 attendees")'); await p.waitForSelector('text=Watch time saved');
    log('zoom:', (await p.locator('.bg-emerald-50').first().innerText()).replace(/\n/g, ' '));
    await p.screenshot({ path: `${SHOTS}/3-zoom-result.png` });
    await p.click('button:has-text("Add 20 as new leads")'); await p.waitForSelector('text=new leads added');
    log('new attendees:', await p.locator('text=new leads added').innerText());
    await p.click('button:has-text("Done")');

    // Reminder calls (before the webinar) by the reminder caller, sales calls (after) by reps.
    const ac = await client('e2e-rc@closeros-test.dev');
    const { data: outs } = await ac.from('call_outcomes').select('id,code,category,purpose');
    const O = c => outs.find(o => o.code === c).id;
    const { data: bl } = await admin.from('batch_leads').select('lead_id, watch_minutes, reminder_by, is_repeat, lead:leads(phone, assigned_to, profession)').eq('batch_id', batchId);
    const remCount = { visible: 0 }; const { count: rcSees } = await ac.from('leads').select('id', { count: 'exact', head: true });
    log('reminder caller can see', rcSees, 'leads (expected 300 = registrations they must call)');
    const before = new Date(d.getTime() - 86400000).toISOString();
    const facts = new Map(bl.map(x => [x.lead_id, { ...x, attempts: 0, max: 0, guided: false, saleCalls: 0, smax: 0 }]));
    let k = 0;
    for (const x of bl.filter(x => x.reminder_by)) {
      k++; if (k % 5 === 0) continue; // 20% never called
      const guided = k % 3 !== 0; const dur = guided ? 60 + (k % 120) : 0;
      const { error } = await ac.rpc('log_call', { p: { id: crypto.randomUUID(), org_id: orgId, lead_id: x.lead_id, phone: x.lead.phone, direction: 'outgoing', started_at: before, duration_sec: dur, purpose: 'reminder', batch_id: batchId,
        outcome_id: guided ? O('r_guided') : O('r_didnt_pick'), no_follow_up: true, profession: k % 7 === 0 ? 'Loan agent' : null } });
      if (error) throw error;
      const f = facts.get(x.lead_id); f.attempts++; f.max = Math.max(f.max, dur); f.guided = f.guided || guided;
      if (k % 7 === 0) f.lead.profession = 'Loan agent';
    }
    for (const [i, rep] of reps.entries()) {
      const rc = await client(`e2e-r${i + 1}@closeros-test.dev`);
      const mine = bl.filter(x => x.lead.assigned_to === rep);
      for (const [j, x] of mine.entries()) {
        if (j % 4 === 0) continue; // left to dial
        const dur = [0, 12, 45, 400, 90, 0, 310][j % 7];
        const won = dur === 400 && j % 2 === 0;
        const { error } = await rc.rpc('log_call', { p: { id: crypto.randomUUID(), org_id: orgId, lead_id: x.lead_id, phone: x.lead.phone, direction: 'outgoing', started_at: new Date().toISOString(), duration_sec: dur,
          purpose: 'sales', batch_id: batchId, outcome_id: won ? O('sale_closed') : dur > 30 ? O('interested') : O('no_answer'), outcome_data: won ? { amount: 24999 } : {}, no_follow_up: true } });
        if (error) throw error;
        const f = facts.get(x.lead_id); f.saleCalls++; f.smax = Math.max(f.smax, dur); f.won = won;
      }
    }

    // Expected numbers, computed independently.
    const all = [...facts.values()]; const hot = f => (f.watch_minutes ?? 0) >= 60;
    const exp = rep => { const L = all.filter(f => f.lead.assigned_to === rep); return {
      assigned: L.length, hot: L.filter(hot).length, called: L.filter(f => f.saleCalls).length, picked: L.filter(f => f.smax > 30).length,
      not_picked: L.filter(f => f.saleCalls && f.smax === 0).length, over5: L.filter(f => f.smax > 300).length, over5_hot: L.filter(f => f.smax > 300 && hot(f)).length,
      left_to_dial: L.filter(f => !f.saleCalls).length, left_to_dial_hot: L.filter(f => !f.saleCalls && hot(f)).length, won: L.filter(f => f.won).length } };
    const { data: sales } = await oc.rpc('batch_report', { p_batch: batchId, p_purpose: 'sales' });
    for (const rep of reps) { const got = sales.reps.find(x => x.g === 0 && x.rep === rep); const e = exp(rep); check(`sales ${rep.slice(0, 4)}`, Object.fromEntries(Object.keys(e).map(k => [k, got[k]])), e) }
    const { data: rem } = await oc.rpc('batch_report', { p_batch: batchId, p_purpose: 'reminder' });
    const rt = rem.reps.find(x => x.g === 1);
    check('reminder total', { assigned: rt.assigned, called: rt.called, guided: rt.guided, repeated: rt.repeated, prev_enrolled: rt.prev_enrolled },
      { assigned: all.length, called: all.filter(f => f.attempts).length, guided: all.filter(f => f.guided).length, repeated: all.filter(f => f.is_repeat).length, prev_enrolled: 5 });
    check('attendees with watch time', all.filter(f => f.watch_minutes > 0).length, 200);
    check('summed minutes for twice-joined Reg 0', all.find(f => f.lead.phone === '+919810000000').watch_minutes, watch.get('+919810000000'));
    // A sales rep only sees their own batch leads.
    const r1 = await client('e2e-r1@closeros-test.dev'); const { data: r1rep } = await r1.rpc('batch_report', { p_batch: batchId, p_purpose: 'sales' });
    check('rep1 sees only own row', r1rep.reps.filter(x => x.g === 0).map(x => x.rep), [reps[0]]);

    // Screenshots of the report
    await p.reload(); await p.waitForSelector('text=By team member'); await p.waitForTimeout(800);
    await p.screenshot({ path: `${SHOTS}/4-sales.png`, fullPage: true });
    await p.locator('tbody tr').first().locator('td').nth(3).locator('button').click(); await p.waitForSelector('text=leads', { timeout: 10000 }); await p.waitForTimeout(800);
    await p.screenshot({ path: `${SHOTS}/5-drilldown.png` });
    await p.locator('.max-w-2xl tbody tr').first().click(); await p.waitForSelector('text=Webinars >> nth=1').catch(() => {}); await p.waitForTimeout(1200);
    await p.screenshot({ path: `${SHOTS}/6-lead.png` });
    await p.keyboard.press('Escape'); await p.reload();
    await p.waitForSelector('text=Reminder calls · before'); await p.click('text=Reminder calls · before'); await p.waitForSelector('text=Lead quality by profession'); await p.waitForTimeout(800);
    await p.screenshot({ path: `${SHOTS}/7-reminder.png`, fullPage: true });
    // Lead drawer of an enrolled repeat lead
    await p.goto('http://localhost:4173/leads'); await p.waitForSelector('nav >> text=Leads'); await p.fill('input[placeholder="Search name, phone or email"]', 'Old Lead 1'); try { await p.waitForSelector('tbody tr:has-text("Old Lead 1")', { timeout: 20000 }) } catch (e) { await p.screenshot({ path: `${SHOTS}/fail.png` }); console.log('MAIN', (await p.locator('main').innerText()).slice(0, 600).replace(/\n/g, ' | ')); throw e }
    await p.locator('tbody tr', { hasText: 'Old Lead 1' }).first().click(); await p.waitForSelector('text=Already enrolled'); await p.waitForTimeout(500);
    await p.screenshot({ path: `${SHOTS}/8-enrolled.png` });
    await p.goto('http://localhost:4173/webinars'); await p.waitForSelector('text=Uploaded'); await p.screenshot({ path: `${SHOTS}/9-webinars.png` });
    log('page errors:', errors.length ? errors : 'none');
    await browser.close();
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const x of orgs ?? []) await admin.from('organizations').delete().eq('id', x.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    log('cleaned up', fails ? `— ${fails} CHECKS FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
