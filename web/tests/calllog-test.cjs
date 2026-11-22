// Call log upgrade (# column, column filters, recording reasons, notes). Was: Daily summary card on the Dashboard (morning / evening, team + one person, copy text / image / PDF). Temporary company, cleaned up.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; const ids = []; let org; let fails = 0;
const log = (...a) => console.log('•', ...a);
(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test-12345-abc', email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const o = await mk('sum-owner@closeros-test.dev', 'Priya Owner'); const a = await mk('sum-rep1@closeros-test.dev', 'Nikhil Yadav'); const b = await mk('sum-rep2@closeros-test.dev', 'Amee Shah')
    const { data: og, error: oe } = await admin.from('organizations').insert({ name: 'Summary Co (TEST)', created_by: o }).select().single(); if (oe) throw oe; org = og.id
    await admin.from('org_members').insert([{ org_id: org, user_id: o, role: 'owner' }, { org_id: org, user_id: a, role: 'rep' }, { org_id: org, user_id: b, role: 'rep' }])
    const names = ['Anita Verma', 'Rohit Jain', 'Meera Iyer', 'Sanjay Rao', 'Pooja Nair', 'Vivek Singh', 'Kavya Menon', 'Arjun Das']
    const { error: le } = await admin.from('leads').insert(names.map((n, i) => ({ org_id: org, name: n, phone: '+9198000000' + String(i).padStart(2, '0'),
      assigned_to: i % 2 ? a : b, intent: i < 3 ? (i === 0 ? 'ready' : 'hot') : null, source: 'Webinar sheet' }))); if (le) throw le
    const { data: lds } = await admin.from('leads').select('id,name,phone').eq('org_id', org)
    const bs = []
    for (const d of [20, 10]) { const { data: bt, error: be } = await admin.from('batches').insert({ org_id: org, name: `Webinar ${d} days ago`, webinar_at: new Date(Date.now() - d * 864e5).toISOString() }).select().single(); if (be) throw be; bs.push(bt.id) }
    const bl = []
    lds.forEach((l, i) => { bl.push({ batch_id: bs[0], lead_id: l.id, org_id: org, watch_minutes: 20 + i * 9, attended: true, chat_count: i % 2 ? 2 : 0, poll_answered: 0 })
      if (i % 3 !== 1) bl.push({ batch_id: bs[1], lead_id: l.id, org_id: org, watch_minutes: 10 + i * 7, attended: true, chat_count: 0, poll_answered: 0 }) })
    const { error: ble } = await admin.from('batch_leads').insert(bl); if (ble) console.log('batch_leads', ble.message)
    const now = Date.now(), calls = []
    for (let i = 0; i < 24; i++) calls.push({ id: require('crypto').randomUUID(), org_id: org, user_id: i % 3 ? a : b, direction: i % 7 === 0 ? 'missed' : 'outgoing', phone: '+9198000000' + String(i % 15).padStart(2, '0'),
      started_at: new Date(now - (i + 1) * 17 * 60e3).toISOString(), duration_sec: i % 2 ? 0 : 30 + i * 11, lead_id: lds.find(l => l.phone === '+9198000000' + String(i % 15).padStart(2, '0'))?.id ?? null, sim_number: i % 3 ? '+919811122233' : null, notes: i === 2 ? 'Interested in the weekend batch' : null })
    const { error: ce } = await admin.from('calls').insert(calls); if (ce) throw ce
    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } }); const errors = []
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage(); p.setDefaultTimeout(20000)
    p.on('pageerror', e => errors.push(e.message))
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'sum-owner@closeros-test.dev'); await p.fill('input[type=password]', 'Test-12345-abc'); await p.click('button[type=submit]')
    await p.waitForTimeout(4000); await p.goto('http://localhost:4173/calls'); await p.waitForSelector('text=Dialled from'); await p.waitForTimeout(2500)
    await p.screenshot({ path: `${SHOTS}/calls.png` }); log('shot calls')
    await p.click('text=✎ Write a note >> nth=0'); await p.fill('textarea', 'Asked for the fee details, call back Monday'); await p.click('text=Save note'); await p.waitForTimeout(2000)
    const { data: act } = await admin.from('lead_activities').select('data').eq('org_id', org).eq('kind', 'note'); log('notes saved:', act?.length); if (!act?.length) fails++
    await p.screenshot({ path: `${SHOTS}/calls-note.png` })
    await p.selectOption('select >> nth=7', { index: 1 }).catch(() => {}); await p.click('text=Apply filters'); await p.waitForTimeout(2500); await p.screenshot({ path: `${SHOTS}/calls-filtered.png` }); log('filtered')
    await p.goto('http://localhost:4173/leads'); await p.waitForSelector('table >> text=Anita Verma'); await p.waitForTimeout(1000); await p.screenshot({ path: `${SHOTS}/leads.png` }); log('shot leads'); await p.goto('http://localhost:4173/settings'); await p.waitForTimeout(4000); const h = p.locator('text=Company WhatsApp messages'); await h.scrollIntoViewIfNeeded(); await p.waitForTimeout(2500); await p.screenshot({ path: `${SHOTS}/templates.png` }); log('shot templates'); await p.goto('http://localhost:4173/reports'); await p.waitForTimeout(5000); await p.click('text=Team'); await p.waitForTimeout(3000); await p.screenshot({ path: `${SHOTS}/reports-team.png` })
    log('browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++
    await browser.close()
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    if (org) await admin.from('organizations').delete().eq('id', org)
    for (const id of ids) await admin.auth.admin.deleteUser(id)
    log(fails ? 'problems' : 'done · cleaned up')
  }
})()
