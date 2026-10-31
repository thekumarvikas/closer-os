const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const PASS = 'Test-Pass-12345'; let fails = 0; const ids = [];
const check = (l, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log('•', l, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
(async () => {
  try {
    const mk = async (e, n) => { const { data } = await admin.auth.admin.createUser({ email: e, password: PASS, email_confirm: true, user_metadata: { full_name: n } }); ids.push(data.user.id); return data.user.id };
    const owner = await mk('e2e-owner@closeros-test.dev', 'Owner'); const rep = await mk('e2e-rep@closeros-test.dev', 'Rep');
    const oc = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await oc.auth.signInWithPassword({ email: 'e2e-owner@closeros-test.dev', password: PASS });
    const { data: org } = await oc.rpc('create_organization', { p_name: 'Sync (TEST)' });
    await admin.from('org_members').insert({ org_id: org, user_id: rep, role: 'rep' });
    const { data: lead } = await admin.from('leads').insert({ org_id: org, name: 'Anita', phone: '+919876500001', assigned_to: rep }).select().single();
    const rc = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await rc.auth.signInWithPassword({ email: 'e2e-rep@closeros-test.dev', password: PASS });
    const id1 = crypto.randomUUID(), id2 = crypto.randomUUID(), id3 = crypto.randomUUID();
    const t = new Date().toISOString();
    const batch = [
      { id: id1, phone: '09876500001', direction: 'outgoing', started_at: t, duration_sec: 95, device_id: 'd1', sim_slot: 1, sim_label: 'SIM 1 · Jio' },
      { id: id2, phone: '+91 99999 11111', direction: 'missed', started_at: t, duration_sec: 27, device_id: 'd1' },
      { id: id3, phone: '', direction: 'incoming', started_at: t, duration_sec: 10, device_id: 'd1' },
    ];
    let { data: s1, error } = await rc.rpc('sync_calls', { p_org: org, p_calls: batch }); if (error) throw error;
    check('sync: stored 2, skipped private', [s1.synced, s1.skipped], [2, 1]);
    check('lead matched from 0-prefixed number', s1.calls.find(c => c.id === id1).lead_id, lead.id);
    const { data: oc2 } = await rc.from('call_outcomes').select('id').eq('code', 'interested').single();
    ({ error } = await rc.rpc('log_call', { p: { id: id1, org_id: org, lead_id: lead.id, phone: '+919876500001', direction: 'outgoing', started_at: t, duration_sec: 95, outcome_id: oc2.id, follow_up_at: new Date(Date.now() + 86400000).toISOString() } }));
    if (error) throw error;
    await rc.rpc('sync_calls', { p_org: org, p_calls: batch });
    const { data: rows } = await admin.from('calls').select('id, duration_sec, outcome_id, lead_id').eq('org_id', org);
    check('no duplicates after re-sync + outcome', rows.length, 2);
    check('outcome kept on synced call', rows.find(x => x.id === id1).outcome_id, oc2.id);
    check('missed call duration forced to 0', rows.find(x => x.id === id2).duration_sec, 0);
    await admin.from('organizations').update({ settings: { call_tracking: 'leads' } }).eq('id', org);
    const { data: s3 } = await rc.rpc('sync_calls', { p_org: org, p_calls: [{ id: crypto.randomUUID(), phone: '9000000002', direction: 'outgoing', started_at: t, duration_sec: 5 }] });
    check('"lead calls only" skips unknown numbers', [s3.synced, s3.skipped], [0, 1]);
    const { data: f } = await rc.from('follow_ups').select('id').eq('lead_id', lead.id).eq('status', 'pending');
    check('follow-up created for rep', f.length, 1);
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const x of orgs ?? []) await admin.from('organizations').delete().eq('id', x.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log('• cleaned up', fails ? `— ${fails} FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1) });
