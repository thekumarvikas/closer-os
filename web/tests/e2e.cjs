// End-to-end test of the web dashboard against the real Supabase project.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const SECRET = process.env.SB_SECRET;
const PUB = process.env.SB_PUB;
const SHOTS = process.argv[2];
const admin = createClient(URL, SECRET, { auth: { persistSession: false } });
const OWNER = { email: 'e2e-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const REP = { email: 'e2e-rep@closeros-test.dev', password: 'Test-Rep-12345' };
const log = (...a) => console.log('•', ...a);

async function mkUser(u, name) {
  const { data, error } = await admin.auth.admin.createUser({ ...u, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error; return data.user.id;
}
async function login(page, u) {
  await page.goto('http://localhost:4173/');
  await page.fill('input[type=email]', u.email);
  await page.fill('input[type=password]', u.password);
  await page.click('button[type=submit]');
}

(async () => {
  const ownerId = await mkUser(OWNER, 'Vikas Kumar');
  const repId = await mkUser(REP, 'Rahul Sharma');
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
  const errors = [];
  try {
    // ── Owner: sign in, create company
    const o = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
    o.on('pageerror', e => errors.push('owner page: ' + e.message));
    await o.goto('http://localhost:4173/'); await o.screenshot({ path: `${SHOTS}/01-login.png` });
    await login(o, OWNER);
    await o.waitForSelector('text=Set up your company');
    await o.screenshot({ path: `${SHOTS}/02-onboarding.png` });
    await o.fill('input[placeholder="e.g. Kumar Coaching"]', 'Kumar Coaching (TEST)');
    await o.click('text=Create company');
    await o.waitForSelector('text=Get started');
    log('company created');

    // ── Invite rep
    await o.click('nav >> text=Team');
    await o.click('text=Invite people');
    await o.fill('textarea', REP.email);
    await o.click('button:has-text("Invite"):not(:has-text("people"))');
    await o.waitForSelector('text=Copy message');
    await o.screenshot({ path: `${SHOTS}/03-invite.png` });
    await o.click('button:has-text("Done")');
    log('rep invited');

    // ── Rep signs in → auto-joins
    const rp = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
    rp.on('pageerror', e => errors.push('rep page: ' + e.message));
    await login(rp, REP);
    await rp.waitForSelector('nav >> text=Leads');
    const repNav = await rp.locator('nav a').allInnerTexts();
    log('rep joined; rep menu =', repNav.join(', '));

    // ── Owner: team, import leads
    await o.reload(); await o.click('nav >> text=Team'); await o.waitForSelector('text=Rahul Sharma');
    await o.fill('input[placeholder="New team name"]', 'Team Alpha'); await o.click('text=Add team');
    await o.waitForSelector('select:has-text("Add someone to Team Alpha")');
    await o.selectOption('select:has-text("Add someone to Team Alpha")', { label: 'Rahul Sharma' });
    await o.waitForTimeout(800);
    await o.screenshot({ path: `${SHOTS}/04-team.png`, fullPage: true });

    const csv = 'Full Name,Mobile Number,Email,City,Lead Source,Batch\n' +
      'Anita Desai,98765 01001,anita@example.com,Pune,Facebook,Oct-A\n' +
      'Rohit Verma,+91 98765 01002,,Delhi,Facebook,Oct-A\n' +
      'Sneha Iyer,098765 01003,sneha@example.com,Chennai,Webinar,Oct-B\n' +
      'Duplicate Anita,9876501001,,Pune,Facebook,Oct-A\n' +
      'Bad Number,12345,,Mumbai,Facebook,Oct-A\n' +
      'Karan Mehta,9876501004,karan@example.com,Mumbai,Google,Oct-B\n';
    fs.writeFileSync(`${SHOTS}/leads.csv`, csv);
    await o.click('nav >> text=Leads');
    await o.click('button:has-text("Import")');
    await o.setInputFiles('input[type=file]', `${SHOTS}/leads.csv`);
    await o.waitForSelector('text=Match your columns');
    await o.selectOption('select:has-text("Use my distribution rules")', 'user');
    await o.selectOption('select:has-text("Choose…")', { label: 'Rahul Sharma' });
    await o.screenshot({ path: `${SHOTS}/05-import-mapping.png` });
    await o.click('button:has-text("Import 6 leads")');
    await o.waitForSelector('text=leads imported');
    const res = await o.locator('.py-6.text-center').innerText();
    log('import result:', res.replace(/\n/g, ' | '));
    await o.screenshot({ path: `${SHOTS}/06-import-done.png` });
    await o.click('button:has-text("Done")');
    await o.waitForSelector('text=Anita Desai');
    await o.screenshot({ path: `${SHOTS}/07-leads.png` });

    // ── Rep sees only own leads; simulate the Android app saving a call
    await rp.click('nav >> text=Leads'); await rp.waitForSelector('text=Anita Desai');
    const repLeadCount = await rp.locator('tbody tr').count();
    log('rep sees', repLeadCount, 'leads');
    const app = createClient(URL, PUB, { auth: { persistSession: false } });
    await app.auth.signInWithPassword(REP);
    const { data: org } = await app.from('organizations').select('id').single();
    const { data: lead } = await app.from('leads').select('id').eq('name', 'Anita Desai').single();
    const { data: oc } = await app.from('call_outcomes').select('id,code').in('code', ['interested', 'sale_closed', 'no_answer']);
    const id = c => oc.find(x => x.code === c).id;
    const call = (extra) => app.rpc('log_call', { p: { id: crypto.randomUUID(), org_id: org.id, direction: 'outgoing', phone: '9876501001', started_at: new Date().toISOString(), device_id: 'e2e', sim_slot: 1, sim_label: 'Jio', ...extra } });
    let r2 = await call({ lead_id: lead.id, duration_sec: 0, outcome_id: id('no_answer'), follow_up_at: new Date(Date.now() + 3600000).toISOString(), recording_status: 'not_expected' });
    let r1 = await call({ lead_id: lead.id, duration_sec: 185, outcome_id: id('interested'), follow_up_at: new Date(Date.now() + 2 * 86400000).toISOString(), notes: 'Wants EMI option', recording_status: 'uploaded' });
    const { data: k } = await app.from('leads').select('id').eq('name', 'Karan Mehta').single();
    let r3 = await call({ lead_id: k.id, phone: '9876501004', duration_sec: 420, outcome_id: id('sale_closed'), outcome_data: { amount: 24999 }, no_follow_up: true, recording_status: 'missing' });
    log('app calls saved:', [r1, r2, r3].map(x => x.error ? 'ERR ' + x.error.message : 'ok').join(', '));
    const bad = await call({ lead_id: k.id, duration_sec: 30, outcome_id: id('interested') });
    log('call without next-call time rejected:', !!bad.error);
    const { data: fu } = await app.from('follow_ups').select('status,due_at').eq('lead_id', lead.id).order('created_at');
    log('Anita follow-ups (expect cancelled, pending):', fu.map(x => x.status).join(', '));

    // ── Owner views calls, follow-ups, overview, lead drawer
    await o.click('nav >> text=Overview'); await o.waitForSelector('text=Team today'); await o.waitForTimeout(800);
    await o.screenshot({ path: `${SHOTS}/08-overview.png`, fullPage: true });
    await o.click('nav >> text=Calls'); await o.waitForSelector('text=Wants EMI', { state: 'detached' }).catch(() => {});
    await o.waitForSelector('tbody tr'); await o.screenshot({ path: `${SHOTS}/09-calls.png` });
    await o.click('nav >> text=Follow-ups'); await o.click('button:has-text("Upcoming")'); await o.waitForSelector('text=Anita Desai');
    await o.screenshot({ path: `${SHOTS}/10-followups.png` });
    await o.click('nav >> text=Leads'); await o.click('text=Anita Desai'); await o.waitForSelector('text=Activity'); await o.waitForTimeout(500);
    await o.screenshot({ path: `${SHOTS}/11-lead-detail.png` });
    await o.keyboard.press('Escape'); await o.mouse.click(50, 400);
    await o.click('nav >> text=Settings'); await o.waitForSelector('text=Lead distribution');
    await o.screenshot({ path: `${SHOTS}/12-settings.png`, fullPage: true });

    // ── Mobile layout
    const m = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await login(m, OWNER); await m.waitForSelector('text=Calls today'); await m.waitForTimeout(800);
    await m.screenshot({ path: `${SHOTS}/13-mobile.png`, fullPage: true });
    log('page errors:', errors.length ? errors : 'none');
  } finally {
    await browser.close();
    // Clean up: delete test company and users.
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const x of orgs ?? []) await admin.from('organizations').delete().eq('id', x.id);
    await admin.auth.admin.deleteUser(ownerId); await admin.auth.admin.deleteUser(repId);
    log('cleaned up');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
