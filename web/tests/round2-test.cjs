const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const { chromium } = require('playwright');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const SHOTS = process.argv[2]; const PASS = 'Test-Pass-12345'; const ids = []; let fails = 0;
const check = (l, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log('•', l, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
const login = async e => { const c = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: PASS }); return c };
(async () => {
  try {
    const mk = async (e, n) => { const { data } = await admin.auth.admin.createUser({ email: e, password: PASS, email_confirm: true, user_metadata: { full_name: n } }); ids.push(data.user.id); return data.user.id };
    const owner = await mk('e2e-owner@closeros-test.dev', 'Vikas Kumar'); const a = await mk('e2e-a@closeros-test.dev', 'Ankit Singh'); const b = await mk('e2e-b@closeros-test.dev', 'Rajni Bhati');
    const oc = await login('e2e-owner@closeros-test.dev'); const { data: org } = await oc.rpc('create_organization', { p_name: 'Round2 (TEST)' });
    await admin.from('org_members').insert([a, b].map(u => ({ org_id: org, user_id: u, role: 'rep' })));
    const ac = await login('e2e-a@closeros-test.dev'), bc = await login('e2e-b@closeros-test.dev');
    const { data: t } = await ac.from('message_templates').select('name').eq('org_id', org); check('rep sees 5 WhatsApp templates', t.length, 5);
    const { data: lead } = await admin.from('leads').insert({ org_id: org, name: 'Rec Lead', phone: '+919876512345', assigned_to: a }).select().single();
    const callId = crypto.randomUUID();
    await ac.rpc('sync_calls', { p_org: org, p_calls: [{ id: callId, phone: '9876512345', direction: 'outgoing', started_at: new Date().toISOString(), duration_sec: 75 }] });
    const { data: l2 } = await admin.from('leads').select('last_connected_at').eq('id', lead.id).single(); check('last conversation recorded', !!l2.last_connected_at, true);
    // A tiny fake audio file
    const bytes = new Uint8Array(2048).fill(7);
    let up = await ac.storage.from('recordings').upload(`${org}/${a}/${callId}.m4a`, bytes, { contentType: 'audio/mp4' }); check('rep uploads own recording', up.error?.message ?? null, null);
    up = await bc.storage.from('recordings').upload(`${org}/${a}/x.m4a`, bytes); check('rep cannot upload into another rep folder', !!up.error, true);
    let e = (await ac.rpc('set_call_recording', { p_call: callId, p_path: `${org}/${a}/${callId}.m4a`, p_size: 2048 })).error; check('register recording', e, null);
    const own = await ac.storage.from('recordings').createSignedUrl(`${org}/${a}/${callId}.m4a`, 60); check('rep can play own recording', !!own.data?.signedUrl, true);
    const other = await bc.storage.from('recordings').createSignedUrl(`${org}/${a}/${callId}.m4a`, 60); check('other rep cannot play it', !!other.data?.signedUrl, false);
    const mgr = await oc.storage.from('recordings').createSignedUrl(`${org}/${a}/${callId}.m4a`, 60); check('owner can play it', !!mgr.data?.signedUrl, true);
    const res = await fetch(mgr.data.signedUrl); check('signed link downloads the file', (await res.arrayBuffer()).byteLength, 2048);
    await oc.rpc('log_recording_access', { p_call: callId, p_action: 'play' });
    const { count: au } = await admin.from('audit_logs').select('*', { count: 'exact', head: true }).eq('org_id', org).eq('action', 'recording.play'); check('play written to audit log', au, 1);
    const { data: emb, error: ee } = await ac.from('leads').select('*, batch_leads(watch_minutes, attended, batch:batches(name, webinar_at))').eq('org_id', org);
    check('lead query with webinar details (app)', [ee, emb.length], [null, 1]);
    // Team comparison needs ≥2 people with calls
    await bc.rpc('sync_calls', { p_org: org, p_calls: [1, 2, 3].map(i => ({ id: crypto.randomUUID(), phone: `98000000${10 + i}`, direction: 'outgoing', started_at: new Date(Date.now() - i * 60000).toISOString(), duration_sec: i * 40 })) });

    const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
    const errors = []; const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', x => errors.push(x.message));
    await p.goto('http://localhost:4173/'); await p.fill('input[type=email]', 'e2e-owner@closeros-test.dev'); await p.fill('input[type=password]', PASS); await p.click('button[type=submit]');
    await p.waitForSelector('nav >> text=Reports'); await p.click('nav >> text=Reports'); await p.getByRole('button', { name: 'Team', exact: true }).click();
    await p.waitForSelector('text=Compare the team', { timeout: 30000 }); await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/1-team-compare.png`, fullPage: true });
    await p.click('nav >> text=Calls'); await p.waitForSelector('button[title="Play recording"]', { timeout: 30000 }); await p.click('button[title="Play recording"]'); await p.waitForSelector('audio', { timeout: 15000 });
    check('dashboard shows audio player', await p.locator('audio').count(), 1); await p.screenshot({ path: `${SHOTS}/2-play.png` });
    await p.click('nav >> text=Settings'); await p.waitForSelector('text=WhatsApp messages'); await p.locator('text=WhatsApp messages').scrollIntoViewIfNeeded(); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/3-templates.png` });
    console.log('• page errors:', errors.length ? errors : 'none');
    await browser.close();
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const o of orgs ?? []) {
      const { data: files } = await admin.storage.from('recordings').list(o.id, { limit: 100 });
      for (const d of files ?? []) { const { data: f2 } = await admin.storage.from('recordings').list(`${o.id}/${d.name}`); if (f2?.length) await admin.storage.from('recordings').remove(f2.map(x => `${o.id}/${d.name}/${x.name}`)) }
      await admin.from('organizations').delete().eq('id', o.id);
    }
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log('• cleaned up', fails ? `— ${fails} FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1) });
