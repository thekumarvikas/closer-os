// Round 14: sheet leads + webinar from a column, Leads page, webinar cards, new Sales page (owner's buyers sheet format), Training.
// Seeds a temporary company, drives the real dashboard, takes screenshots, then deletes everything. Same env vars as e2e.cjs.
const { createRequire } = require('module');
const r = createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2];
const OWNER = { email: 'r14-owner@closeros-test.dev', password: 'Test-Owner-12345' };
const log = (...a) => console.log('•', ...a);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ids = []; let orgId = null;

(async () => {
  try {
    const mk = async (email, name) => { const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test-Pass-12345', email_confirm: true, user_metadata: { full_name: name } }); if (error) throw error; ids.push(data.user.id); return data.user.id };
    const owner = await mk(OWNER.email, 'Vikas Kumar'); await admin.auth.admin.updateUserById(owner, { password: OWNER.password });
    const repA = await mk('r14-rep1@closeros-test.dev', 'Priya Sharma'); const repB = await mk('r14-rep2@closeros-test.dev', 'Rahul Verma');
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
    await repC.auth.signInWithPassword({ email: 'r14-rep1@closeros-test.dev', password: 'Test-Pass-12345' });
    const claimLead = L.find(l => l.assigned_to === repA && !calls.some(c => c.lead_id === l.id && c.duration_sec > 60)) ?? L[1];
    const { error: ce } = await repC.rpc('claim_sale', { p_lead: claimLead.id, p: { amount: '18000', product: 'Gold Program', note: 'Paid 5,000 token by UPI' } }); if (ce) throw ce;
    // Sheet leads through the real ingest function: webinar taken from a column, people in turns.
    const { data: src } = await admin.from('lead_sources').insert({ org_id: org.id, name: 'Registrations sheet', kind: 'google_sheets', webinar_mode: 'column', webinar_column: 'Webinar Date',
      assign_mode: 'users', assign_users: [repA, repB] }).select().single();
    const next = new Date(now + 5 * 86400000); const wd = `${next.getDate()}th ${next.toLocaleString('en-GB', { month: 'short' })} - ${next.getFullYear()}`;
    for (let i = 0; i < 6; i++) {
      const { data: r } = await admin.rpc('ingest_lead', { p_token: src.token, p_payload: { 'Name ': `Sheet Lead ${i}`, 'Phone ': `9198660000${10 + i}`, 'Email ': `sheet${i}@example.com`,
        'Date & Time ': new Date(now - i * 3600000).toLocaleString('en-GB'), 'Experience': '2-5 Years', 'Webinar Date': wd, 'Team Member ': i === 0 ? 'Priya Sharma' : '' } });
      if (!r?.ok) throw new Error('ingest failed ' + JSON.stringify(r));
    }
    await admin.from('leads').insert([0, 1, 2].map(i => ({ org_id: org.id, name: `Unassigned ${i}`, phone: `+9198550000${10 + i}`, source: 'Old sheet' })));
    const { data: auto } = await admin.from('batches').select('name, webinar_at, auto_created').eq('org_id', org.id).eq('auto_created', true);
    log('webinar created from the sheet:', JSON.stringify(auto));
    const { data: sl } = await admin.from('leads').select('name, assigned_to, signup_at').eq('org_id', org.id).like('name', 'Sheet Lead%').order('name');
    log('sheet leads assigned:', sl.map(l => l.assigned_to === repA ? 'A' : l.assigned_to === repB ? 'B' : '-').join(''));

    // Buyers file in the owner's master-sheet format: one row per payment.
    const buyers = L.filter((_, i) => i % 5 === 0);
    const rows = [['S. No.', 'Payment Date', 'Webinar Date', 'Program Name', 'Batch No.', 'Name', 'Email ID', 'Contact Number', 'Engineering field', 'Profession', 'City/Location', 'Country',
      'Direct/Sales Team', 'Team Member Name', 'Amount Paid', 'Price Point', 'Pending Amount', 'Method', 'Part/Full', 'Remark']];
    const dmy = d => new Date(d).toLocaleDateString('en-GB');
    buyers.forEach((l, i) => {
      const b = B[i % 3]; const paid = new Date(new Date(b.webinar_at).getTime() + (1 + (i % 5) * 2) * 86400000); if (paid.getTime() > now) paid.setTime(now - 3600000);
      const base = [i + 1, dmy(paid), dmy(b.webinar_at), 'Planning Pro Course', `Batch ${12 + (i % 2)}`, `Buyer ${i}`, '', l.phone.slice(3) + '.0', 'Civil', 'Engineer', 'Pune', 'India'];
      if (i % 4 === 0) rows.push([...base, 'Live Webinar Full', '', 29500, 29500, 0, 'Razorpay', 'Full', '']);
      else if (i % 4 === 1) { rows.push([...base, 'Sales Team Part', 'Priya Sharma', 5000, 29500, 24500, 'Personal UPI', 'Part', 'balance later']);
        const p2 = new Date(Math.min(now - 60000, paid.getTime() + 4 * 86400000)); rows.push([i + 100, dmy(p2), ...base.slice(2), 'Sales Team Part to Full', 'Priya Sharma', 24500, 29500, 0, 'Bank', 'Full', '']); }
      else if (i % 4 === 2) rows.push([...base, 'Sales Team Part', 'Rahul', 10000, 29500, 19500, 'Personal UPI', 'Part', '']);
      else rows.push([...base, 'Sales Team Full', 'Rahul Verma', 29500, 29500, 0, 'Razorpay', 'Full', '']);
    });
    rows.push([999, dmy(now - 86400000), '', 'Planning Pro Course', 'Batch 13', 'Omar Khan', 'omar@example.com', '501234567', 'Civil', 'PE', 'Dubai', 'UAE', 'Sales Team Full', 'Priya', 29500, 29500, 0, 'Razorpay', 'Full', '']);
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const file = `${SHOTS}/buyers-master.csv`; fs.writeFileSync(file, csv);
    await admin.from('organizations').update({ settings: { sales: { gst_pct: 18 } } }).eq('id', org.id);

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = [];
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
    p.setDefaultTimeout(20000); p.on('dialog', d => d.accept()); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', OWNER.email); await p.fill('input[type=password]', OWNER.password); await p.click('button[type=submit]');
    await p.waitForTimeout(3000);
    const shot = async n => { await p.waitForTimeout(1800); await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); log('screenshot', n) };

    await p.goto('http://localhost:4173/leads'); await p.waitForSelector('text=Unassigned (3)'); await shot('1a-leads');
    await p.click('button:has-text("Unassigned (3)")'); await p.waitForSelector('text=3 leads match'); await p.waitForTimeout(800); await p.locator('thead input[type=checkbox]').check(); await shot('1b-leads-unassigned');
    await p.click('button:has-text("Assign / share out")'); await p.waitForSelector('text=Assign 3 leads'); await p.locator('label:has-text("Priya Sharma") input').check(); await p.locator('label:has-text("Rahul Verma") input').check();
    await p.getByRole('button', { name: 'Assign', exact: true }).click(); await p.waitForTimeout(1500);
    await p.click('button:has-text("All leads")'); await p.click('button:has-text("Columns")'); await p.locator('label:has-text("Experience") input').check(); await p.click('button:has-text("Done")');
    await p.selectOption('select:has(option:text("Form field: any"))', 'experience'); await p.fill('input[placeholder="contains…"]', '2-5'); await shot('1c-leads-draft-filter');
    await p.click('button:has-text("Apply filters")'); await p.waitForTimeout(800); await shot('1d-leads-filtered');
    await p.locator('table').last().locator('tbody tr').first().click(); await p.waitForSelector('text=Form / sheet answers'); await shot('1e-lead-drawer');

    await p.goto('http://localhost:4173/lead-sources'); await p.waitForSelector('text=Registrations sheet'); await p.click('text=Registrations sheet'); await p.click('button:has-text("Edit settings")');
    await p.waitForSelector('text=Which webinar do these leads join'); await shot('2-source-settings'); await p.keyboard.press('Escape');

    await p.goto('http://localhost:4173/webinars'); await p.waitForSelector('text=Registered'); await shot('3a-webinar-cards');
    await p.locator('a:has-text("Share out sales calls"), a:has-text("Upload Zoom reports")').first().click(); await p.waitForSelector('text=After the webinar'); await shot('3b-after-webinar');
    await p.keyboard.press('Escape');

    await p.goto('http://localhost:4173/buyers'); await p.waitForSelector('text=Upload a CSV');
    await p.setInputFiles('input[type=file]', file); await p.waitForSelector('text=Check which column is which'); await shot('4a-buyers-mapping');
    await p.getByRole('button', { name: /^Import \d+ buyers/ }).click(); await p.waitForSelector('text=Done:', { timeout: 60000 }); await shot('4b-buyers-result');
    log('import result:', await p.textContent('text=Done:'));

    await p.goto('http://localhost:4173/sales'); await p.waitForSelector('text=By team member'); await p.click('button:has-text("Last 90 days")'); await p.waitForSelector('text=What buyers have in common'); await p.waitForTimeout(2500); await shot('5a-sales-overview');
    await p.click('button:has-text("Buyers (")'); await p.waitForSelector('text=Days to convert from'); await shot('5b-sales-buyers');
    await p.click('button:has-text("Fastest first")'); await p.click('button:has-text("Webinar attended")'); await shot('5c-buyers-fastest-webinar');
    await p.locator('tbody tr').first().click(); await p.waitForSelector('text=from sign-up'); await shot('5d-journey');
    await p.click('button:has-text("Edit · payments")'); await p.waitForTimeout(4000); await shot('5e-sale-modal'); log('sale modal has Edit sale:', await p.locator('text=Edit sale').count());
    await p.goto('http://localhost:4173/training'); await p.waitForSelector('text=Winning calls'); await shot('6-training');
    await p.goto('http://localhost:4173/settings'); await p.waitForSelector('text=Ready-made: Pre-webinar countdown'); await p.click('button:has-text("Ready-made: Pre-webinar countdown")'); await p.waitForSelector('text=Start by itself when a lead registers'); await shot('7-countdown');

    const { data: s } = await admin.from('sales').select('id, amount, credited_to, sale_channel, enrol_batch, webinar_batch_id, lead_id, buyer').eq('org_id', org.id).eq('source', 'import');
    const { data: pm } = await admin.from('sale_payments').select('sale_id, amount').eq('org_id', org.id);
    log('orders:', s.length, '(expected', buyers.length + 1, ') payments:', pm.length, 'matched:', s.filter(x => x.lead_id).length, 'webinar-channel:', s.filter(x => x.sale_channel === 'webinar').length,
      'credited A/B/none:', s.filter(x => x.credited_to === repA).length, s.filter(x => x.credited_to === repB).length, s.filter(x => !x.credited_to).length,
      'with webinar:', s.filter(x => x.webinar_batch_id).length, 'UAE phone:', s.find(x => x.buyer?.name === 'Omar Khan')?.buyer?.phone);
    log('browser errors:', errors.length ? errors : 'none');
    await browser.close();
  } catch (e) { console.error('FAILED', e) } finally {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    log('cleaned up');
  }
})();
