// A company with NO leads uploads a real Zoom webinar attendee report (attendees + registrants who didn't join)
// into an empty webinar: the upload must work and offer to add everyone as leads. Temporary data, cleaned up after.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const [SHOTS, FILE] = process.argv.slice(2);
const OWNER = { email: 'zoom-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const log = (...a) => console.log('•', ...a);
let uid, orgId, fails = 0;
const check = (ok, what) => { if (!ok) fails++; log(ok ? 'OK  ' : 'FAIL', what) };
(async () => {
  try {
    const { data: u, error } = await admin.auth.admin.createUser({ ...OWNER, email_confirm: true, user_metadata: { full_name: 'Zoom Owner' } }); if (error) throw error; uid = u.user.id;
    const { data: org } = await admin.from('organizations').insert({ name: 'Cancer Circle (TEST)', created_by: uid }).select().single(); orgId = org.id;
    await admin.from('org_members').insert({ org_id: org.id, user_id: uid, role: 'owner' });
    const { data: b } = await admin.from('batches').insert({ org_id: org.id, name: '16 Nov TEST', webinar_at: '2026-11-16T13:30:00Z', created_by: uid }).select().single();
    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage(); p.setDefaultTimeout(20000);
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
    const shot = async n => { await p.waitForTimeout(1200); await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); log('screenshot', n) };
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', OWNER.email); await p.fill('input[type=password]', OWNER.password); await p.click('button[type=submit]');
    await p.waitForTimeout(3000);
    await p.goto(`http://localhost:4173/webinars/${b.id}`); await p.waitForTimeout(2500); await shot('1-webinar');
    await p.click('button:has-text("After the webinar")');
    await p.setInputFiles('input[type=file]', FILE); await p.waitForTimeout(1500); await shot('2-picked');
    await p.click('button:has-text("Next")'); await p.waitForTimeout(2500); await shot('3-zoom-screen');
    const match = p.locator('button:has-text("Save watch time for")'); log('match button:', await match.count() ? await match.innerText() : 'none', 'disabled:', await match.count() ? await match.isDisabled() : '-');
    if (await match.count() && !(await match.isDisabled())) { await match.click(); await p.waitForTimeout(4000); await shot('4-after-match')
      await p.click('button:has-text("as new leads")'); await p.waitForTimeout(6000); await shot('5-added')
      const { data: bl } = await admin.from('batch_leads').select('watch_minutes, attended, registered, leads!inner(name, phone)').eq('batch_id', b.id)
      log('batch leads:', bl?.length, 'attended:', bl?.filter(x => x.attended).length, 'registered:', bl?.filter(x => x.registered).length, 'sum minutes:', bl?.reduce((a, x) => a + (x.watch_minutes || 0), 0))
      const sh = bl?.find(x => /Shweta/.test(x.leads.name)); log('Shweta minutes (was 150, webinar is 137):', sh?.watch_minutes)
      check(!bl?.some(x => /Fireflies|Notetaker/i.test(x.leads.name)), 'note-taker bot not added')
      check(bl?.filter(x => x.registered).length > 100, 'Zoom registrants marked registered')
      const { count } = await admin.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', org.id); log('leads in company:', count) }
    log('browser errors:', errors.length ? errors : 'none');
    await browser.close();
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    if (uid) await admin.auth.admin.deleteUser(uid);
    log(fails ? `${fails} problem(s)` : 'done', '· cleaned up')
  }
})();
