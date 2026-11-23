// Closer OS support access: Super Admin sees nothing of a company until it opens a recorded visit; view-only blocks
// changes; the company sees the visit; the company can turn access off. Temporary users + company, cleaned up after.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const SA = { email: 'sa-support@closeros-test.dev', password: 'Test-Admin-12345' };
const OWNER = { email: 'support-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const log = (...a) => console.log('•', ...a);
const ids = []; let fails = 0;
const check = (ok, what) => { if (!ok) fails++; log(ok ? 'OK  ' : 'FAIL', what) };
const client = async u => { const c = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword(u); if (error) throw error; return c };

(async () => {
  try {
    const mk = async (u, name) => { const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const sa = await mk(SA, 'Support Person'); await mk(OWNER, 'Client Owner');
    await admin.from('profiles').update({ is_super_admin: true }).eq('id', sa);
    const own = await client(OWNER);
    const { data: orgId, error: oe } = await own.rpc('create_organization', { p_name: 'Support Check Co (TEST)' }); if (oe) throw oe;
    const org = typeof orgId === 'string' ? orgId : orgId?.id;
    const { error: le } = await own.rpc('add_lead', { p_org: org, p: { name: 'Priya Test Lead', phone: '9876500011' } }); if (le) throw le;

    const sac = await client(SA);
    const { data: before } = await sac.from('leads').select('id').eq('org_id', org);
    check((before ?? []).length === 0, `Super Admin sees no leads before a visit (${(before ?? []).length})`);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage(); p.setDefaultTimeout(20000);
    p.on('pageerror', e => errors.push(e.message));
    const shot = async n => { await p.waitForTimeout(1200); await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }); log('screenshot', n) };
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', SA.email); await p.fill('input[type=password]', SA.password); await p.click('button[type=submit]');
    await p.waitForSelector('text=Just me', { timeout: 15000 }); await p.click('text=Just me');
    await p.waitForSelector('button:has-text("Create my account")'); await p.click('button:has-text("Create my account")'); await p.waitForTimeout(4000);
    await p.goto('http://localhost:4173/admin'); await p.waitForTimeout(5000); await shot('0-admin'); await p.waitForSelector('text=Support Check Co (TEST)');
    await p.locator('tr', { hasText: 'Support Check Co (TEST)' }).locator('button:has-text("Open")').click();
    await p.fill('input[placeholder^="e.g. Checking"]', 'Test visit'); await shot('1-open-dialog');
    await p.locator('.fixed button:has-text("Open")').last().click();
    await p.waitForSelector('text=as Closer OS support'); await shot('2-banner-dashboard');
    await p.goto('http://localhost:4173/leads'); await p.waitForTimeout(5000); await p.waitForSelector('td >> text=Priya Test Lead'); await shot('3-leads');
    check(true, 'company leads visible during the visit');
    await p.goto('http://localhost:4173/settings'); await p.waitForSelector('text=Company name');
    await p.locator('input.input').first().fill('Renamed by support'); await p.locator('form button[type=submit]').first().click();
    await p.waitForTimeout(1500); await shot('4-view-only-blocked');
    const { data: o1 } = await admin.from('organizations').select('name').eq('id', org).single();
    check(o1.name === 'Support Check Co (TEST)', `view-only blocked the rename (name now: ${o1.name})`);
    await p.click('button:has-text("Exit")'); await p.waitForTimeout(3000);
    const { data: after } = await sac.from('leads').select('id').eq('org_id', org);
    check((after ?? []).length === 0, 'nothing visible after Exit');

    const { data: visits } = await own.rpc('support_visits', { p_org: org });
    check((visits ?? []).length === 1 && visits[0].reason === 'Test visit' && visits[0].mode === 'view', `company sees the visit (${JSON.stringify(visits?.[0] ?? null).slice(0, 120)})`);
    const op = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage(); op.setDefaultTimeout(20000);
    op.on('pageerror', e => errors.push(e.message));
    await op.goto('http://localhost:4173/'); await op.fill('input[type=email]', OWNER.email); await op.fill('input[type=password]', OWNER.password); await op.click('button[type=submit]');
    await op.waitForTimeout(4000); await op.goto('http://localhost:4173/settings'); await op.waitForSelector('text=Closer OS support access');
    await op.locator('text=Closer OS support access').scrollIntoViewIfNeeded(); await op.waitForTimeout(1000);
    await op.screenshot({ path: `${SHOTS}/5-client-settings.png` }); log('screenshot 5-client-settings');

    await own.rpc('set_support_access', { p_org: org, p_on: false });
    const { error: offErr } = await sac.rpc('sa_support_open', { p_org: org, p_mode: 'view' });
    check(!!offErr && /turned off support access/.test(offErr.message), `access refused when turned off (${offErr?.message ?? 'no error'})`);
    log('browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++;
    await browser.close();
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    await admin.from('organizations').delete().ilike('name', '%(TEST)%');
    for (const id of ids) { await admin.from('organizations').delete().eq('created_by', id); await admin.auth.admin.deleteUser(id) }
    log(fails ? `${fails} problem(s)` : 'all checks passed', '· cleaned up')
  }
})();
