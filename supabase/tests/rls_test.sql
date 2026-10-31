-- Access-rule test. Runs as fake users inside one transaction and always rolls back:
-- it ends by raising an "error" whose message is the test report.
do $$
declare
  o uuid := gen_random_uuid(); m uuid := gen_random_uuid();
  r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid();
  v_org uuid; v_team uuid; res jsonb; n int; l1 uuid; out text := ''; ok boolean;
  v_outcome uuid;
  procedure_as text;
begin
  insert into auth.users (id, email, aud, role) values
    (o, 'owner@test.local', 'authenticated', 'authenticated'),
    (m, 'manager@test.local', 'authenticated', 'authenticated'),
    (r1, 'rep1@test.local', 'authenticated', 'authenticated'),
    (r2, 'rep2@test.local', 'authenticated', 'authenticated');

  -- Owner sets up the company.
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_org := public.create_organization('Test Co');
  insert into public.org_members (org_id, user_id, role) values (v_org, m, 'manager'), (v_org, r1, 'rep'), (v_org, r2, 'rep');
  insert into public.teams (org_id, name) values (v_org, 'Team A') returning id into v_team;
  insert into public.team_members (team_id, user_id, org_id, is_manager) values (v_team, m, v_org, true), (v_team, r1, v_org, false);
  insert into public.distribution_rules (org_id, name, method, user_ids) values (v_org, 'RR', 'round_robin', array[r1, r2]);
  res := public.import_leads(v_org, '[
    {"name":"A","phone":"98765 43210"},
    {"name":"B","phone":"+91 9876543211"},
    {"name":"C","phone":"09876543212","city":"Pune","batch":"Oct"},
    {"name":"A dup","phone":"9876543210"},
    {"name":"Bad","phone":"123"}]'::jsonb, 'csv');
  out := out || format(E'import: %s (expect 3 inserted, 1 dup, 1 invalid)\n', res);
  select string_agg(name || '→' || case assigned_to when r1 then 'R1' when r2 then 'R2' else '?' end, ', ' order by name)
    into procedure_as from public.leads where org_id = v_org;
  out := out || format(E'round-robin: %s (expect A→R1, B→R2, C→R1)\n', procedure_as);
  select custom::text into procedure_as from public.leads where org_id = v_org and name = 'C';
  out := out || format(E'extra column kept as custom field: %s\n', procedure_as);
  reset role;

  -- Rep 1.
  perform set_config('request.jwt.claims', json_build_object('sub', r1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.leads; out := out || format(E'R1 sees %s leads (expect 2)\n', n);
  select id into l1 from public.leads where name = 'A';
  begin update public.leads set assigned_to = r2 where id = l1; ok := true;
  exception when others then ok := false; end;
  out := out || format(E'R1 can reassign lead: %s (expect false)\n', ok);
  select id into v_outcome from public.call_outcomes where code = 'interested';
  begin
    perform public.log_call(jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'lead_id', l1, 'direction', 'outgoing',
      'phone', '9876543210', 'started_at', now(), 'duration_sec', 60, 'outcome_id', v_outcome)); ok := true;
  exception when others then ok := false; end;
  out := out || format(E'R1 can save outcome without next-call time: %s (expect false)\n', ok);
  res := public.log_call(jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'lead_id', l1, 'direction', 'outgoing',
      'phone', '9876543210', 'started_at', now(), 'duration_sec', 60, 'outcome_id', v_outcome,
      'follow_up_at', now() + interval '2 days', 'notes', 'Wants EMI option'));
  select count(*) into n from public.follow_ups where lead_id = l1 and status = 'pending';
  out := out || format(E'R1 call saved with follow-up: %s pending follow-up (expect 1)\n', n);
  begin update public.profiles set is_super_admin = true where id = r1; ok := true;
  exception when others then ok := false; end;
  out := out || format(E'R1 can make self super admin: %s (expect false)\n', ok);
  reset role;

  -- Rep 2 (not in Team A).
  perform set_config('request.jwt.claims', json_build_object('sub', r2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.leads; out := out || format(E'R2 sees %s leads (expect 1)\n', n);
  select count(*) into n from public.calls; out := out || format(E'R2 sees %s calls (expect 0)\n', n);
  begin insert into public.leads (org_id, name, phone, assigned_to) values (v_org, 'Mine', '9000000001', r1); ok := true;
  exception when others then ok := false; end;
  select assigned_to = r2 into ok from public.leads where phone = '+919000000001';
  out := out || format(E'R2 creating a lead keeps it for R2: %s (expect true)\n', ok);
  reset role;

  -- Manager of Team A.
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.leads; out := out || format(E'Manager sees %s leads (expect 2: only R1''s)\n', n);
  select count(*) into n from public.calls; out := out || format(E'Manager sees %s calls (expect 1)\n', n);
  select count(*) into n from public.audit_logs; out := out || format(E'Manager sees %s audit rows (expect 0)\n', n);
  reset role;

  -- Outsider with no company.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.leads; out := out || format(E'Outsider sees %s leads (expect 0)\n', n);
  reset role;

  raise exception E'TEST REPORT\n%', out;
end $$;
