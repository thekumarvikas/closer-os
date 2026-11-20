// Team page: one table (member, role, work SIM, phone, recordings, last synced, ⋯ menu). Temporary company, cleaned up.
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
    const o = await mk('team-owner@closeros-test.dev', 'Priya Owner'); const a = await mk('team-rep1@closeros-test.dev', 'Nikhil Yadav'); const b = await mk('team-rep2@closeros-test.dev', 'Amee Shah with a very long name')
    const { data: og, error: oe } = await admin.from('organizations').insert({ name: 'Team Co (TEST)', created_by: o }).select().single(); if (oe) throw oe; org = og.id
    await admin.from('org_members').insert([{ org_id: org, user_id: o, role: 'owner' }, { org_id: org, user_id: a, role: 'rep', call_team: 'sales' }, { org_id: org, user_id: b, role: 'rep' }])
    await admin.from('device_status').insert([
      { org_id: org, user_id: a, device_id: 'd1', model: 'LAVA LZG414', android: '14', app_version: '0.28.0', default_dialer: 'com.android.dialer', rec_folder_set: true, rec_files_found: 0, rec_matched: 0, rec_uploaded_total: 0, setup: { calls: true, battery: true, overlay: false }, updated_at: new Date().toISOString() },
      { org_id: org, user_id: b, device_id: 'd2', model: 'realme RMX3933', android: '16', app_version: '0.27.3', default_dialer: 'com.google.android.dialer', rec_folder_set: false, rec_uploaded_total: 0, setup: { calls: true, battery: false, autostart: false }, updated_at: new Date(Date.now() - 5 * 3600e3).toISOString() }])
    await admin.from('member_sims').insert({ org_id: org, user_id: a, sim_number: '+918130253162', slot: 2, label: 'SIM 2', kind: 'first', status: 'active' })
    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } }); const errors = []
    for (const [w, h, n] of [[1440, 900, 'team-desktop'], [1024, 900, 'team-laptop']]) {
      const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage(); p.setDefaultTimeout(20000)
      p.on('pageerror', e => errors.push(e.message))
      await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'team-owner@closeros-test.dev'); await p.fill('input[type=password]', 'Test-12345-abc'); await p.click('button[type=submit]')
      await p.waitForTimeout(4000); await p.goto('http://localhost:4173/team'); await p.waitForSelector('text=Nikhil Yadav'); await p.waitForTimeout(2500)
      await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); log('shot', n)
      if (n === 'team-desktop') { await p.click('[aria-label="More actions"] >> nth=0'); await p.waitForTimeout(400); await p.screenshot({ path: `${SHOTS}/team-menu.png` }) }
    }
    log('browser errors:', errors.length ? errors : 'none'); if (errors.length) fails++
    await browser.close()
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    if (org) await admin.from('organizations').delete().eq('id', org)
    for (const id of ids) await admin.auth.admin.deleteUser(id)
    log(fails ? 'problems' : 'done · cleaned up')
  }
})()
