// Team member's webinar cards (every number opens its leads) + web calling queue bar. Temporary company, cleaned up.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const admin = createClient('https://tdbqgoxxxfkfttdznzhb.supabase.co', process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; let org, ids = [], fails = 0;
(async () => { try {
  const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test-12345-abc', email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id }
  const o = await mk('rq-owner@closeros-test.dev', 'Owner'); const rep = await mk('rq-rep@closeros-test.dev', 'Nikhil Rep')
  const { data: og } = await admin.from('organizations').insert({ name: 'Queue Co (TEST)', created_by: o }).select().single(); org = og.id
  await admin.from('org_members').insert([{ org_id: org, user_id: o, role: 'owner' }, { org_id: org, user_id: rep, role: 'rep' }])
  const { data: b } = await admin.from('batches').insert({ org_id: org, name: 'Webinar 23 Nov', webinar_at: new Date(Date.now() - 2 * 864e5).toISOString(), zoom_uploaded_at: new Date().toISOString() }).select().single()
  const { data: ls } = await admin.from('leads').insert(['Asha', 'Bala', 'Chetan'].map((n, i) => ({ org_id: org, name: n, phone: '+9198100000' + i, assigned_to: rep }))).select()
  await admin.from('batch_leads').insert(ls.map((l, i) => ({ org_id: org, batch_id: b.id, lead_id: l.id, attended: i < 2, watch_minutes: i < 2 ? 70 : 0 })))
  const br = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } }); const errors = []
  const p = await (await br.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); p.setDefaultTimeout(20000); p.on('pageerror', e => errors.push(e.message))
  await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'rq-rep@closeros-test.dev'); await p.fill('input[type=password]', 'Test-12345-abc'); await p.click('button[type=submit]')
  await p.waitForTimeout(4000); await p.goto('http://localhost:4173/webinars'); await p.waitForSelector('text=Not called yet'); await p.waitForTimeout(1500)
  await p.screenshot({ path: `${SHOTS}/rep-webinars.png` }); console.log('• rep webinar cards')
  await p.locator('button:has-text("Joined")').first().click(); await p.waitForSelector('text=in a queue'); console.log('• Joined list:', await p.locator('text=/Call all \\d+ in a queue/').innerText())
  await p.click('text=/Call all \\d+ in a queue/'); await p.waitForSelector('text=Calling queue'); await p.waitForTimeout(1500)
  await p.screenshot({ path: `${SHOTS}/rep-queue.png` }); console.log('• queue bar:', (await p.locator('text=Calling queue').innerText()))
  const { data: reqs } = await admin.from('call_requests').select('status, phone').eq('org_id', org); console.log('• phone asked to call:', JSON.stringify(reqs))
  console.log('• browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++
  await br.close()
} catch (e) { console.error('FAILED', e.message); fails++ } finally {
  if (org) await admin.from('organizations').delete().eq('id', org); for (const id of ids) await admin.auth.admin.deleteUser(id); console.log(fails ? 'problems' : 'done · cleaned up') } })()
