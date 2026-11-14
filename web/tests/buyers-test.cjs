// Buyer Analysis + verified sales + duplicate leads, through the real dashboard.
// Seeds a temporary company (owner + 2 reps, 80 leads over 30 days, webinars, calls), imports a messy buyers CSV
// through the page, checks every step, takes screenshots, then deletes everything. Same env vars as e2e.cjs.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const OWNER = { email: 'ba-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const log = (...a) => console.log('•', ...a);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ids = []; let orgId = null;

(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test-Pass-12345', email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const owner = await mk(OWNER.email, 'Vikas Kumar'); await admin.auth.admin.updateUserById(owner, { password: OWNER.password });
    const repA = await mk('ba-rep1@closeros-test.dev', 'Priya Sharma'); const repB = await mk('ba-rep2@closeros-test.dev', 'Rahul Verma');
    const { data: org, error: oe } = await admin.from('organizations').insert({ name: 'Kumar Coaching (TEST)', created_by: owner }).select().single(); if (oe) throw oe;
    orgId = org.id;
    await admin.from('org_members').insert([{ org_id: org.id, user_id: owner, role: 'owner' }, { org_id: org.id, user_id: repA, role: 'rep' }, { org_id: org.id, user_id: repB, role: 'rep' }]);
    const outs = [['no_answer', 'No Answer', 'not_connected'], ['interested', 'Interested', 'positive'], ['call_back', 'Call back', 'connected'], ['not_interested', 'Not interested', 'lost'], ['sale', 'Sale closed', 'won']];
    const { data: oc } = await admin.from('call_outcomes').insert(outs.map(([code, label, category], i) => ({ org_id: org.id, code, label, category, position: i, form: code === 'sale' ? 'sale' : null }))).select();
    await admin.from('products').insert([{ org_id: org.id, name: 'Gold Program', price: 25000, position: 1 }, { org_id: org.id, name: 'Silver Program', price: 9999, position: 2 }]);
    const now = Date.now(); const reps = [repA, repB];
    const { data: B } = await admin.from('batches').insert([0, 1, 2].map(i => ({ org_id: org.id, name: `Wealth Webinar ${i + 1}`, webinar_at: new Date(now - (25 - i * 9) * 86400000).toISOString(), created_by: owner }))).select();
    const leads = []; for (let i = 0; i < 80; i++) leads.push({ org_id: org.id, name: ['Asha', 'Bala', 'Chetan', 'Divya', 'Esha', 'Farhan', 'Gita', 'Harsh'][i % 8] + ' ' + (100 + i),
      phone: `+9198${String(77000000 + i).padStart(8, '0')}`, email: i % 3 === 0 ? `lead${i}@gmail.com` : null, assigned_to: reps[i % 2], source: i % 2 ? 'Facebook' : 'Instagram',
      created_at: new Date(now - (28 - (i % 27)) * 86400000 + 10.5 * 3600000).toISOString() });
    const { data: L, error: le } = await admin.from('leads').insert(leads).select('id,phone,email,assigned_to,created_at'); if (le) throw le;
    // A duplicate written differently (same last 10 digits) for the merge step.
    await admin.from('leads').insert({ org_id: org.id, name: 'Asha 100 (old list)', phone: '+19877000000', assigned_to: repA, source: 'Old sheet' });
    // Webinar attendance and calls: buyers-to-be are called fast and watch long.
    const bl = [], calls = [];
    L.forEach((l, i) => {
      const buyer = i % 5 === 0; const b = B[i % 3]; const watch = buyer ? 60 + Math.floor(rnd() * 40) : Math.floor(rnd() * 90);
      bl.push({ batch_id: b.id, lead_id: l.id, org_id: org.id, watch_minutes: watch, attended: watch > 0 });
      const start = new Date(l.created_at).getTime();
      const firstGap = (buyer || rnd() < 0.4) ? (2 + rnd() * 8) * 60000 : (30 + rnd() * 600) * 60000;
      const n = 1 + Math.floor(rnd() * (buyer ? 6 : 3));
      for (let k = 0; k < n; k++) {
        const t = start + firstGap + k * 86400000 * (0.5 + rnd()); if (t > now) break;
        const talk = rnd() < 0.6 ? Math.round(30 + rnd() * 500) : 0;
        calls.push({ id: crypto.randomUUID(), org_id: org.id, user_id: l.assigned_to, lead_id: l.id, phone: l.phone, direction: 'outgoing', started_at: new Date(t).toISOString(),
          duration_sec: talk, outcome_id: talk ? oc[1 + Math.floor(rnd() * 3)].id : oc[0].id, outcome_data: {}, sim_slot: 1 });
      }
    });
    await admin.from('batch_leads').insert(bl);
    for (let i = 0; i < calls.length; i += 500) { const { error } = await admin.from('calls').insert(calls.slice(i, i + 500)); if (error) throw error; }
    log('seeded', L.length, 'leads,', calls.length, 'calls, 3 webinars');
    // A rep claims a sale (saves a "Sale closed" outcome) → waits for the manager.
    const repC = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } });
    await repC.auth.signInWithPassword({ email: 'ba-rep1@closeros-test.dev', password: 'Test-Pass-12345' });
    const claimLead = L.find(l => l.assigned_to === repA && !calls.some(c => c.lead_id === l.id && c.duration_sec > 60)) ?? L[1];
    const { error: ce } = await repC.rpc('claim_sale', { p_lead: claimLead.id, p: { amount: '18000', product: 'Gold Program', note: 'Paid 5,000 token by UPI' } }); if (ce) throw ce;
    log('rep claimed a sale');

    // Messy buyers file: spaces, +91 / 91 / 0, dashes, misspelt gmail, bad rows, an unknown buyer, a same-day duplicate.
    const buyers = L.filter((_, i) => i % 5 === 0);
    const fmt = (p, i) => { const d = p.slice(3); return [` 91 ${d.slice(0, 5)}-${d.slice(5)} `, `0${d}`, `+91${d}`, `${d.slice(0, 5)} ${d.slice(5)}`][i % 4] };
    const rows = [['Timestamp', 'Full Name', 'Mobile No', 'Email ID', 'Course', 'Amount Paid', 'UTR No']];
    buyers.forEach((l, i) => {
      const paid = new Date(new Date(l.created_at).getTime() + (1 + (i % 4) * 3) * 86400000);
      rows.push([paid.toLocaleDateString('en-GB'), `Buyer ${i}`, i === 3 ? '' : fmt(l.phone, i), i === 3 ? (l.email ?? 'lead0@gmail.com').replace('gmail', 'gmial') : '', i % 2 ? 'Gold Program' : 'Silver Program',
        i % 2 ? '₹25,000' : '9,999', `UTR${1000 + i}`]);
    });
    rows.push([new Date().toLocaleDateString('en-GB'), 'Walk-in buyer', '+1 415 555 0101', '', 'Gold Program', '25000', 'UTR9001']);
    rows.push(['', 'Broken', '12345', '', 'Gold Program', '100', '']);
    rows.push(['', 'No contact', '', '', 'Gold Program', '100', '']);
    rows.push([rows[1][0], 'Buyer 0 again', rows[1][2], '', rows[1][4] + ' Plus', rows[1][5], 'UTR777']);
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const file = `${SHOTS}/buyers-test.csv`; fs.writeFileSync(file, csv);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', OWNER.email); await p.fill('input[type=password]', OWNER.password); await p.click('button[type=submit]');
    await p.waitForTimeout(3000);
    const shot = async n => { await p.waitForTimeout(1800); await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); log('screenshot', n) };

    // 1 Import
    await p.goto('http://localhost:4173/buyers'); await p.waitForSelector('text=Upload a CSV');
    await p.setInputFiles('input[type=file]', file); await p.waitForSelector('text=Check which column is which');
    await shot('1a-import-mapping');
    await p.getByRole('button', { name: /^Import \d+ buyers/ }).click(); await p.waitForSelector('text=Done:', { timeout: 60000 });
    await shot('1b-import-result');
    log('import result:', await p.textContent('text=Done:'));
    // 2 Match
    await p.click('button:has-text("2 · Match to leads")'); await p.waitForSelector('text=Unmatched buyers'); await shot('2-matching');
    // 3 Effort
    await p.click('button:has-text("3 · Effort per sale")'); await p.waitForSelector('text=Sign-up → first call', { timeout: 30000 }); await shot('3a-effort');
    await p.locator('tbody tr').first().click(); await p.waitForSelector('text=the path to the sale'); await shot('3b-timeline');
    await p.keyboard.press('Escape');
    // 4 Pattern
    await p.click('button:has-text("4 · Pattern finder")'); await p.waitForSelector('text=Does it make a difference', { timeout: 30000 }); await shot('4-pattern');
    // 5 Gaps
    await p.click('button:has-text("5 · Gaps")'); await p.waitForSelector('text=Look like buyers', { timeout: 30000 }); await shot('5-gaps');
    // Sales: claim waiting for verification + possible duplicate
    await p.goto('http://localhost:4173/sales'); await p.waitForSelector('text=To verify'); await shot('6a-sales-to-verify');
    await p.locator('tbody tr').first().click(); await p.waitForSelector('text=Who talked to this lead'); await shot('6b-sale-verify');
    await p.keyboard.press('Escape');
    // Duplicates on the Leads page
    await p.goto('http://localhost:4173/leads'); await p.click('button:has-text("Possible duplicates")'); await p.waitForSelector('text=Same number'); await shot('7-duplicates');

    // Numbers straight from the database.
    const { data: s } = await admin.from('sales').select('status, source, lead_id, match_how').eq('org_id', org.id);
    log('sales:', s.length, 'verified', s.filter(x => x.status === 'verified').length, 'to verify', s.filter(x => x.status === 'claimed').length,
      'imported matched', s.filter(x => x.source === 'import' && x.lead_id).length, 'unmatched', s.filter(x => x.source === 'import' && !x.lead_id).length);
    const { count: won } = await admin.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', org.id).not('won_at', 'is', null);
    log('leads marked bought:', won, '(expected', buyers.length, ')');
    log('browser errors:', errors.length ? errors : 'none');
    await browser.close();
  } catch (e) { console.error('FAILED', e) } finally {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    log('cleaned up');
  }
})();
