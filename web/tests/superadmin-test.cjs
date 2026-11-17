// Super Admin: add a company by hand, welcome message, health card, edit details; the invited owner signs in and lands
// in that company as owner (webinars menu hidden when the switch is off). Temporary users + company, cleaned up after.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const SA = { email: 'sa-test@closeros-test.dev', password: 'Test-Admin-12345' };
const OWNER = { email: 'new-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const log = (...a) => console.log('•', ...a);
const ids = []; let fails = 0;
const check = (ok, what) => { if (!ok) fails++; log(ok ? 'OK  ' : 'FAIL', what) };

(async () => {
  try { log('start');
    const mk = async (u, name) => { const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const sa = await mk(SA, 'Test Admin'); log('users ok');
    await admin.from('profiles').update({ is_super_admin: true }).eq('id', sa);
    log('launching'); const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    let p = await ctx.newPage(); p.setDefaultTimeout(20000);
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
    const shot = async n => { await p.waitForTimeout(1200); await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); log('screenshot', n) };
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', SA.email); await p.fill('input[type=password]', SA.password); await p.click('button[type=submit]');
    await p.waitForTimeout(3000);
    // The test admin has no company of its own: make a personal one so the dashboard opens.
    if (await p.locator('text=Just me').count()) { await p.click('text=Just me'); await p.click('button:has-text("Create my account")'); await p.waitForTimeout(3000) }
    await p.goto('http://localhost:4173/admin'); await p.waitForTimeout(4000); await p.screenshot({ path: `${SHOTS}/0-admin.png` }); await p.waitForSelector('text=Add a company');
    await p.click('button:has-text("Add a company")');
    await p.fill('input[placeholder="e.g. ABC Academy"]', 'Sharma Coaching (TEST)');
    const inputs = p.locator('.fixed input.input');
    await inputs.nth(1).fill('Ravi Sharma'); await inputs.nth(2).fill('98765 43210'); await inputs.nth(3).fill(OWNER.email);
    await p.click('button:has-text("60 days")');
    await shot('1-add-company');
    await p.click('button:has-text("Add company")'); await p.waitForSelector('text=is ready'); await shot('2-welcome');
    check(await p.locator('text=Send on WhatsApp').count() === 1, 'WhatsApp button shown');
    await p.click('button:has-text("Done")');
    await p.waitForSelector('text=not signed in yet'); await shot('3-companies');
    await p.click('button:has-text("Health")'); await p.waitForSelector('text=Sharma Coaching (TEST)'); await shot('4-health');
    check(await p.locator("text=Owner hasn't signed in yet").count() > 0, 'health says owner not signed in');
    await p.click('text=Sharma Coaching (TEST)'); await p.waitForSelector('text=Plan & access'); await shot('5-edit');
    await p.keyboard.press('Escape');

    // The owner signs in with that email → owner of the company, no Webinars menu.
    await mk(OWNER, 'Ravi Sharma');
    const p2 = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage(); p2.setDefaultTimeout(20000);
    p2.on('pageerror', e => errors.push(e.message));
    await p2.goto('http://localhost:4173/'); await p2.fill('input[type=email]', OWNER.email); await p2.fill('input[type=password]', OWNER.password); await p2.click('button[type=submit]');
    await p2.waitForTimeout(6000); await p2.screenshot({ path: `${SHOTS}/6a-owner-debug.png` }); await p2.waitForSelector('text=Sharma Coaching (TEST)'); await p2.waitForTimeout(2000);
    await p2.screenshot({ path: `${SHOTS}/6-owner-lands.png`, fullPage: true });
    check(await p2.locator('nav >> text=Webinars').count() === 0, 'Webinars menu hidden (switch off)');
    check(await p2.locator('nav >> text=Team').count() === 1, 'owner sees Team');
    const { data: mem } = await admin.from('org_members').select('role, organizations!inner(name)').eq('user_id', ids[1]);
    check(mem?.[0]?.role === 'owner', `owner role → ${mem?.[0]?.role}`);
    log('browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++;
    await browser.close();
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    await admin.from('organizations').delete().ilike('name', '%(TEST)%');
    for (const id of ids) { await admin.from('organizations').delete().eq('created_by', id); await admin.auth.admin.deleteUser(id) }
    log(fails ? `${fails} problem(s)` : 'all checks passed', '· cleaned up')
  }
})();
