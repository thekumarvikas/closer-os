// Lead drawer at a glance: fact tiles, WhatsApp buttons, payment details, save outcome. Temporary company, cleaned up.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const admin = createClient('https://tdbqgoxxxfkfttdznzhb.supabase.co', process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; let org, uid, fails = 0;
(async () => { try {
  const { data: u, error } = await admin.auth.admin.createUser({ email: 'lq-owner@closeros-test.dev', password: 'Test-12345-abc', email_confirm: true, user_metadata: { full_name: 'Prem Shankar' } }); if (error) throw error; uid = u.user.id
  const { data: og } = await admin.from('organizations').insert({ name: 'Quick Co (TEST)', created_by: uid, settings: { payment_details: { upi_id: 'quickco@okhdfc', payee: 'Quick Co', bank: 'A/c 1234\nIFSC HDFC0001', note: 'Please share the screenshot.' } } }).select().single(); org = og.id
  await admin.from('org_members').insert({ org_id: org, user_id: uid, role: 'owner' })
  const { data: b } = await admin.from('batches').insert({ org_id: org, name: 'Webinar 19 Nov', webinar_at: new Date(Date.now() - 4 * 864e5).toISOString(), pay_link: 'https://rzp.io/full', token_link: 'https://rzp.io/token' }).select().single()
  const { data: l } = await admin.from('leads').insert({ org_id: org, name: 'Praveen Kumar Yadav', phone: '+919911395333', profession: 'Financial Consultant', assigned_to: uid, intent: 'hot' }).select().single()
  await admin.from('batch_leads').insert({ org_id: org, batch_id: b.id, lead_id: l.id, watch_minutes: 98, attended: true })
  await admin.from('message_templates').insert([{ org_id: org, name: 'Missed call – call back', body: 'Hi {{leadName}}, I tried calling you. When can we talk?', show_for: ['not_connected'], position: 50 },
    { org_id: org, name: 'Send replay', body: 'Hi {{leadName}}, here is the replay.', show_for: [], position: 51 }, { org_id: org, name: 'Full payment link', body: 'Pay here: {{payLink}}', show_for: [], position: 52 }]).then(x => x.error && console.log('templates', x.error.message))
  await admin.from('calls').insert({ id: require('crypto').randomUUID(), org_id: org, user_id: uid, lead_id: l.id, direction: 'outgoing', phone: '+919911395333', started_at: new Date(Date.now() - 30 * 60e3).toISOString(), duration_sec: 0 })
  const br = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } }); const errors = []
  const p = await (await br.newContext({ viewport: { width: 1280, height: 1100 } })).newPage(); p.setDefaultTimeout(20000); p.on('pageerror', e => errors.push(e.message))
  await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'lq-owner@closeros-test.dev'); await p.fill('input[type=password]', 'Test-12345-abc'); await p.click('button[type=submit]')
  await p.waitForTimeout(4000); await p.goto('http://localhost:4173/leads'); await p.locator('text=Praveen Kumar Yadav >> visible=true').first().click(); await p.waitForSelector('text=Reminder call'); await p.waitForTimeout(1500)
  await p.screenshot({ path: `${SHOTS}/drawer.png` }); console.log('• shot drawer')
  const first = await p.locator('button:has-text("Missed call")').first().innerText(); console.log('• first WA button:', first)
  await p.click('text=Save outcome'); await p.waitForSelector('text=How did the call go?'); await p.screenshot({ path: `${SHOTS}/drawer-outcome.png` }); console.log('• outcome form opens')
  console.log('• browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++
  await br.close()
} catch (e) { console.error('FAILED', e); fails++ } finally {
  if (org) await admin.from('organizations').delete().eq('id', org); if (uid) await admin.auth.admin.deleteUser(uid); console.log(fails ? 'problems' : 'done · cleaned up') } })()
