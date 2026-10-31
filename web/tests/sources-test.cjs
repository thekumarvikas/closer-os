// Lead-sources test: sends real-world payload formats to the live webhook and checks the leads.
const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; const PASS = 'Test-Pass-12345'; const ids = []; let fails = 0;
const check = (l, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log('•', l, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
const hook = t => `${URL}/functions/v1/lead-webhook/${t}`;
const post = async (t, body, type = 'json') => {
  const res = await fetch(hook(t), type === 'json' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  return { status: res.status, body: await res.json() };
};
(async () => {
  try {
    const mk = async (e, n) => { const { data } = await admin.auth.admin.createUser({ email: e, password: PASS, email_confirm: true, user_metadata: { full_name: n } }); ids.push(data.user.id); return data.user.id };
    const owner = await mk('e2e-owner@closeros-test.dev', 'Vikas Kumar'); const r1 = await mk('e2e-r1@closeros-test.dev', 'Ankit'); const r2 = await mk('e2e-r2@closeros-test.dev', 'Sachin');
    const oc = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await oc.auth.signInWithPassword({ email: 'e2e-owner@closeros-test.dev', password: PASS });
    const { data: org } = await oc.rpc('create_organization', { p_name: 'Sources (TEST)' });
    await admin.from('org_members').insert([r1, r2].map(u => ({ org_id: org, user_id: u, role: 'rep' })));
    await admin.from('distribution_rules').insert({ org_id: org, name: 'RR', method: 'round_robin', user_ids: [r1, r2] });
    const { data: batch } = await oc.from('batches').insert({ org_id: org, name: 'Webinar 9 Nov (TEST)', webinar_at: new Date(Date.now() + 3 * 86400000).toISOString() }).select().single();
    const mkSrc = async (kind, extra = {}) => (await oc.from('lead_sources').insert({ org_id: org, name: kind, kind, source_label: kind, ...extra }).select().single()).data;
    const pab = await mkSrc('pabbly', { batch_id: batch.id }), zap = await mkSrc('zapier'), flexi = await mkSrc('flexifunnels', { batch_id: batch.id });
    const gads = await mkSrc('google_ads', { google_key: 'secret123', assign_mode: 'user', assign_to: r2 }), fb = await mkSrc('facebook'), sheet = await mkSrc('google_sheets');

    let x = await post(pab.token, { name: 'Pabbly Person', phone: '98765 40001', email: 'PAB@Mail.com', profession: 'CA', city: 'Pune' });
    check('pabbly → new lead', x.body.status, 'created');
    x = await post(zap.token, [{ full_name: 'Zap One', mobile: '+91-98765-40002' }, { full_name: 'Zap Two', mobile: '9876540003' }]);
    check('zapier array → 2 leads', x.body.results.map(r => r.status), ['created', 'created']);
    x = await post(flexi.token, { 'Full Name': 'Flexi Lead', 'Mobile No': '9876540004', 'Email': 'flexi@mail.com', 'What do you do?': 'Insurance advisor' }, 'form');
    check('flexifunnels form post → new lead', x.body.status, 'created');
    const g = { lead_id: 'abc', api_version: '1.0', form_id: 1, campaign_id: 2, google_key: 'secret123', is_test: false,
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'YouTube Viewer' }, { column_id: 'PHONE_NUMBER', string_value: '+919876540005' }, { column_id: 'EMAIL', string_value: 'yt@mail.com' }] };
    x = await post(gads.token, g); check('youtube/google ads → new lead', x.body.status, 'created');
    x = await post(gads.token, { ...g, google_key: 'wrong' }); check('google ads wrong key rejected', x.body.ok, false);
    x = await post(gads.token, { ...g, is_test: true }); check('google ads "send test data"', x.body.status, 'test');
    x = await post(fb.token, { field_data: [{ name: 'full_name', values: ['FB Lead'] }, { name: 'phone_number', values: ['+919876540006'] }, { name: 'which_course?', values: ['Coaching'] }] });
    check('facebook field_data → new lead', x.body.status, 'created');
    x = await post(sheet.token, { Name: 'Sheet Row', Phone: 9876540007, Profession: 'SEO agency' }); check('google sheets row → new lead', x.body.status, 'created');
    x = await post(pab.token, { name: 'Again', phone: '9876540002' }); check('existing number → joins webinar as repeat', x.body.status, 'joined');
    x = await post(pab.token, { name: 'Again', phone: '9876540002' }); check('same again → duplicate', x.body.status, 'duplicate');
    x = await post(pab.token, { name: 'No phone', email: 'x@y.z' }); check('no phone → logged error', x.body.ok, false);
    x = await post('wrongtoken', { phone: '9876540009' }); check('wrong link → 404', x.status, 404);
    // Field mapping for an unusual field name
    await oc.from('lead_sources').update({ field_map: { phone: 'contact_on_whatsapp' } }).eq('id', zap.id);
    x = await post(zap.token, { full_name: 'Mapped', contact_on_whatsapp: '9876540010' }); check('custom field mapping', x.body.status, 'created');

    const { data: leads } = await admin.from('leads').select('name, phone, email, source, profession, profession_category_id, assigned_to, custom').eq('org_id', org).order('created_at');
    const by = n => leads.find(l => l.name === n);
    check('phone normalised', by('Zap One').phone, '+919876540002');
    check('email lower-cased', by('Pabbly Person').email, 'pab@mail.com');
    check('flexi profession from custom question kept', by('Flexi Lead').custom.what_do_you_do, 'Insurance advisor');
    check('profession grouped', !!by('Pabbly Person').profession_category_id, true);
    check('google ads lead assigned to fixed rep', by('YouTube Viewer').assigned_to, r2);
    check('round-robin spread', new Set(leads.filter(l => l.source !== 'google_ads').map(l => l.assigned_to)).size, 2);
    const { count: inBatch } = await admin.from('batch_leads').select('*', { count: 'exact', head: true }).eq('batch_id', batch.id);
    check('webinar batch got pabbly+flexi+repeat', inBatch, 3);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = []; const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'e2e-owner@closeros-test.dev'); await p.fill('input[type=password]', PASS); await p.click('button[type=submit]');
    await p.waitForSelector('nav >> text=Lead sources'); await p.click('nav >> text=Lead sources'); await p.waitForSelector('text=leads received'); await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/1-sources.png` });
    await p.click('button:has-text("Add lead source")'); await p.waitForSelector('text=Where do your leads come from?'); await p.screenshot({ path: `${SHOTS}/2-choose.png` }); await p.keyboard.press('Escape');
    await p.locator('button', { hasText: 'Pabbly Connect' }).first().click(); await p.waitForSelector('text=How to connect'); await p.waitForTimeout(800);
    await p.screenshot({ path: `${SHOTS}/3-pabbly.png`, fullPage: true });
    await p.click('button:has-text("Send test")'); await p.waitForTimeout(2500);
    check('test from dashboard shows up', await p.locator('text=Test').count() > 0, true);
    await p.mouse.click(100, 400); await p.locator('button', { hasText: 'YouTube / Google Ads' }).first().click(); await p.waitForSelector('text=Google key'); await p.waitForTimeout(500);
    await p.screenshot({ path: `${SHOTS}/4-youtube.png` });
    console.log('• page errors:', errors.length ? errors : 'none');
    await browser.close();
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const o of orgs ?? []) await admin.from('organizations').delete().eq('id', o.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log('• cleaned up', fails ? `— ${fails} FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1) });
