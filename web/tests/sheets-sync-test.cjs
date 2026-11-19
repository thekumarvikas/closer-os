// Google Sheets sync v2: runs the REAL Apps Script (from web/src/lib/sheetScript.ts) in Node with a mocked Google Sheet
// against the live webhook + database. Temporary company, cleaned up after. Usage: node tests/sheets-sync-test.cjs <script.js>
const { createRequire } = require('module')
const r = createRequire(require('path').join(__dirname, '..', 'package.json'))
const { createClient } = r('@supabase/supabase-js')
const { execFileSync } = require('child_process')
const crypto = require('crypto'), fs = require('fs'), vm = require('vm')
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co'
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } })
const log = (...a) => console.log('•', ...a); let fails = 0
const check = (ok, what) => { if (!ok) fails++; log(ok ? 'OK  ' : 'FAIL', what) }

function makeSheet(rows) {
  const props = {}; const triggers = []
  const ss = { getId: () => 'SHEET123', getName: () => 'Test - Dr. Rekha', getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    getSheets: () => [sh], getSheetByName: () => sh }
  const sh = { getSheetId: () => 0, getName: () => 'Sheet1', getDataRange: () => ({ getValues: () => rows }) }
  const tb = (fn) => { const t = { fn, type: 'CLOCK', getHandlerFunction: () => fn, getEventType: () => t.type }
    return { timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push(t) }) }),
      forSpreadsheet: () => ({ onChange: () => ({ create: () => { t.type = 'ON_CHANGE'; triggers.push(t) } }) }) } }
  return { triggers, props, ctx: {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getActive: () => ss, getUi: () => ({ alert: () => {}, createMenu: () => ({ addItem() { return this }, addToUi() {} }) }) },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1), newTrigger: tb, EventType: { CLOCK: 'CLOCK' } },
    PropertiesService: { getDocumentProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v } }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: (d, tz, f) => { const p = n => String(n).padStart(2, '0'); const ist = new Date(d.getTime() + 5.5 * 3600e3)
        if (f === 'HH:mm:ss') return `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`; const s = `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}`; return f.includes('HH') && f.includes('yyyy') ? `${s} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}` : s },
      _x: 0, computeDigest: (a, s) => [...crypto.createHash('md5').update(s).digest()], base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'), DigestAlgorithm: { MD5: 'MD5' } },
    UrlFetchApp: { fetch: (u, o) => { const out = execFileSync('curl', ['-sS', '-w', '\n%{http_code}', '-X', 'POST', u, '-H', 'Content-Type: application/json', '--data-binary', '@-'], { input: o.payload, maxBuffer: 1e8 }).toString()
        const code = Number(out.slice(out.lastIndexOf('\n') + 1)); return { getResponseCode: () => code, getContentText: () => out.slice(0, out.lastIndexOf('\n')) } } },
    String, Number, Math, JSON, Date, Object,
  } }
}

;(async () => {
  let orgId, uid
  try {
    const { data: u } = await admin.auth.admin.createUser({ email: 'sheet-owner@closeros-test.dev', password: 'Test-12345-abc', email_confirm: true, user_metadata: { full_name: 'Sheet Owner' } }); uid = u.user.id
    const { data: rep } = await admin.auth.admin.createUser({ email: 'sheet-rep@closeros-test.dev', password: 'Test-12345-abc', email_confirm: true, user_metadata: { full_name: 'Nikhil Yadav' } })
    const { data: org } = await admin.from('organizations').insert({ name: 'Sheet Co (TEST)', created_by: uid }).select().single(); orgId = org.id
    await admin.from('org_members').insert([{ org_id: orgId, user_id: uid, role: 'owner' }, { org_id: orgId, user_id: rep.user.id, role: 'rep' }])
    const { data: src } = await admin.from('lead_sources').insert({ org_id: orgId, name: 'Webinar Leads', kind: 'google_sheets', assign_mode: 'none', webinar_mode: 'column', webinar_column: 'Webinar Date', webinar_time: '19:00', created_by: uid }).select().single()
    const hook = `${URL}/functions/v1/lead-webhook/${src.token}`
    const head = ['Webinar Date', 'Date', 'Name', 'Email id', 'Contact', 'Assigned']
    const rows = [head]
    for (let i = 0; i < 1000; i++) rows.push([new Date(Date.UTC(2026, 10, i < 500 ? 18 : 25, -5, -30)), new Date(Date.UTC(2026, 10, 12, 8, i % 60)), `Lead ${i}`, `lead${i}@ex.com`, String(7000000000 + i), 'Nikhil'])
    rows.push(['', '', 'Bad Number', 'b@ex.com', '12345', 'Nikhil'])
    rows.push(['', '', 'Lead 5 again', 'lead5@ex.com', String(7000000005), 'Nikhil'])     // same person twice in the sheet
    for (let i = 0; i < 40; i++) rows.push(['', '', '', '', '', 'Nikhil'])                   // empty rows with only the name
    const sheet = makeSheet(rows)
    const code = fs.readFileSync(process.argv[2], 'utf8').replace(/https:\/\/x\.supabase\.co\/functions\/v1\/lead-webhook\/abc/, hook)
    vm.createContext(sheet.ctx); vm.runInContext(code, sheet.ctx)
    const t0 = Date.now(); vm.runInContext('connectCloserOS()', sheet.ctx); log('first run took', Math.round((Date.now() - t0) / 1000), 's')
    check(sheet.triggers.length === 2, `script installed its own triggers → ${sheet.triggers.map(t => t.type).join(', ')}`)
    let { data: s1, error: e1 } = await admin.from('lead_sources').select('*').eq('id', src.id).single(); if (e1) log('select error', e1.message)
    log('counts', JSON.stringify({ created: s1.n_created, dup: s1.n_duplicate, invalid: s1.n_invalid, skipped: s1.n_skipped, failed: s1.n_failed }))
    check(s1.n_created === 1000 && s1.n_invalid === 1 && s1.n_failed === 0, '1,000 real leads = 1,000 created; 1 invalid phone; nothing failed')
    check(s1.sheet?.rows === 1042 && s1.sheet?.sent_up_to === 1042, `health: rows ${s1.sheet?.rows}, sent up to ${s1.sheet?.sent_up_to}`)
    const { count: nLeads } = await admin.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
    const { count: nNikhil } = await admin.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('assigned_to', rep.user.id)
    check(nLeads === 1000 && nNikhil === 1000, `leads in company ${nLeads}, given to Nikhil ${nNikhil}`)
    const { data: bs } = await admin.from('batches').select('name, webinar_at').eq('org_id', orgId).order('webinar_at')
    check(bs.length === 2 && bs.every(b => b.webinar_at.includes('13:30:00')), `webinars ${bs.map(b => b.name + ' @ ' + b.webinar_at).join(' | ')}`)
    // Reinstall: properties lost, run again → nothing counted twice.
    sheet.props.closerOsSent = undefined; delete sheet.props.closerOsSent; sheet.triggers.length = 0
    vm.runInContext('connectCloserOS()', sheet.ctx)
    ;({ data: s1 } = await admin.from('lead_sources').select('*').eq('id', src.id).single())
    check(s1.n_created === 1000 && s1.n_duplicate <= 1, `after reinstall + resend: created ${s1.n_created}, already-leads ${s1.n_duplicate}`)
    // A new row arrives (e.g. from Pabbly) → next minute.
    rows.push([new Date(Date.UTC(2026, 10, 25, -5, -30)), new Date(), 'New Person', 'np@ex.com', '9123456780', 'Nikhil'])
    vm.runInContext('sendToCloserOS()', sheet.ctx)
    ;({ data: s1 } = await admin.from('lead_sources').select('*').eq('id', src.id).single())
    check(s1.n_created === 1001, `new row picked up → created ${s1.n_created}`)
  } catch (e) { console.error('FAILED', e); fails++ } finally {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId)
    const { data: us } = await admin.auth.admin.listUsers({ perPage: 200 })
    for (const x of us.users.filter(x => x.email?.startsWith('sheet-'))) await admin.auth.admin.deleteUser(x.id)
    log(fails ? `${fails} problem(s)` : 'all checks passed', '· cleaned up')
  }
})()
