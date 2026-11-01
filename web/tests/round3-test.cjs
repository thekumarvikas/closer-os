const r = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { createClient } = r('@supabase/supabase-js');
const URL = 'https://tdbqgoxxxfkfttdznzhb.supabase.co';
const admin = createClient(URL, process.env.SB_SECRET, { auth: { persistSession: false } });
const PASS = 'Test-Pass-12345'; const ids = []; let fails = 0;
const check = (l, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log('•', l, ok ? 'OK' : `MISMATCH got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) };
const login = async e => { const c = createClient(URL, process.env.SB_PUB, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: PASS }); return c };
(async () => {
  try {
    const mk = async (e, n) => { const { data } = await admin.auth.admin.createUser({ email: e, password: PASS, email_confirm: true, user_metadata: { full_name: n } }); ids.push(data.user.id); return data.user.id };
    await mk('e2e-owner@closeros-test.dev', 'Owner'); const a = await mk('e2e-a@closeros-test.dev', 'A'); const b = await mk('e2e-b@closeros-test.dev', 'B');
    const oc = await login('e2e-owner@closeros-test.dev'); const { data: org } = await oc.rpc('create_organization', { p_name: 'R3 (TEST)' });
    await admin.from('org_members').insert([a, b].map(u => ({ org_id: org, user_id: u, role: 'rep' })));
    const ac = await login('e2e-a@closeros-test.dev'), bc = await login('e2e-b@closeros-test.dev');
    let e = (await ac.from('message_templates').insert({ org_id: org, name: 'Mine', body: 'Hi {{leadName}}', owner_id: a })).error; check('rep saves own message', e, null);
    e = (await ac.from('message_templates').insert({ org_id: org, name: 'Fake company', body: 'x', owner_id: null })).error; check('rep cannot add company message', !!e, true);
    const { data: ta } = await ac.from('message_templates').select('name, owner_id').eq('org_id', org); check('rep A sees 5 company + 1 own', ta.length, 6);
    const { data: tb } = await bc.from('message_templates').select('name').eq('org_id', org); check('rep B does not see A\'s message', tb.length, 5);
    const { data: up } = await ac.from('message_templates').update({ body: 'hacked' }).is('owner_id', null).eq('org_id', org).select(); check('rep cannot edit company messages', up.length, 0);
    const t = new Date().toISOString();
    await ac.rpc('sync_calls', { p_org: org, p_calls: [
      { id: crypto.randomUUID(), phone: '9800000001', direction: 'outgoing', started_at: t, duration_sec: 30 },
      { id: crypto.randomUUID(), phone: '9800000002', direction: 'outgoing', started_at: t, duration_sec: 0 },
      { id: crypto.randomUUID(), phone: '9800000003', direction: 'incoming', started_at: t, duration_sec: 50 },
      { id: crypto.randomUUID(), phone: '9800000004', direction: 'missed', started_at: t, duration_sec: 0 }] });
    const rep = async dirs => (await oc.rpc('call_report', { p_org: org, p_from: new Date(Date.now() - 3600e3).toISOString(), p_to: new Date(Date.now() + 3600e3).toISOString(), p_dirs: dirs })).data.rows.find(x => x.g === 15)?.calls ?? 0;
    check('report all / dialled / incoming', [await rep(null), await rep(['outgoing']), await rep(['incoming', 'missed', 'rejected'])], [4, 2, 2]);
  } finally {
    const { data: orgs } = await admin.from('organizations').select('id').like('name', '%(TEST)%');
    for (const o of orgs ?? []) await admin.from('organizations').delete().eq('id', o.id);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log('• cleaned up', fails ? `— ${fails} FAILED` : '— all checks passed');
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1) });
