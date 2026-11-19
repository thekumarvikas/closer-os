-- Round 16 · A) Google Sheets sync v2. Owner (Nov 19): honest counts, no blank/name-only rows as leads, strict phone check,
-- re-sends never counted twice, the "Assigned" column gives the lead to that team member, one source per sheet that survives
-- reinstalling the script, health + activity for the dashboard. The script (dashboard → Lead sources) sends batches with a
-- stable _row_key (sheet id + row content) every minute and reports itself through sheet_hello.

alter table public.lead_sources add column if not exists n_created int not null default 0;
alter table public.lead_sources add column if not exists n_duplicate int not null default 0;
alter table public.lead_sources add column if not exists n_invalid int not null default 0;
alter table public.lead_sources add column if not exists n_skipped int not null default 0;
alter table public.lead_sources add column if not exists n_failed int not null default 0;
alter table public.lead_sources add column if not exists last_attempt_at timestamptz;
alter table public.lead_sources add column if not exists last_success_at timestamptz;
alter table public.lead_sources add column if not exists last_error text;
alter table public.lead_sources add column if not exists sheet jsonb;      -- {id, name, tab, rows, sent_up_to, version, trigger_ok, at}
alter table public.lead_source_events add column if not exists row_key text;
create index if not exists lead_source_events_rowkey on public.lead_source_events (source_id, row_key) where row_key is not null;
alter table public.lead_source_events drop constraint if exists lead_source_events_status_check;

-- A phone number that can really be dialled: India +91 = 10 digits starting 6–9; elsewhere 8–15 digits in total.
create or replace function public.phone_is_valid(p text) returns boolean language sql immutable set search_path = '' as $$
  select case
    when p is null or p !~ '^\+\d+$' then false
    when p like '+91%' then p ~ '^\+91[6-9]\d{9}$'
    else length(p) between 9 and 16 and p !~ '^\+(\d)\1+$'
  end
$$;

CREATE OR REPLACE FUNCTION public.ingest_lead(p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.lead_sources; f jsonb; m jsonb; v_prefix text; tz text;
  v_name text; v_phone text; v_email text; v_first text; v_last text; v_status text; v_lead uuid; v_minutes int;
  std text[] := array['name','full_name','fullname','first_name','last_name','phone','phone_number','mobile','email'];
  v_custom jsonb; v_batch uuid; v_row text := nullif(p_payload->>'_row_key', ''); v_ignore text[]; v_digits text; v_signup timestamptz; v_member uuid; v_assign uuid; v_users uuid[]; n int; k text; v jsonb;
begin
  select * into s from public.lead_sources where token = p_token;
  if s.id is null or not s.is_active then
    return jsonb_build_object('ok', false, 'error', 'Unknown or paused lead source');
  end if;
  if s.google_key is not null and s.google_key <> '' and p_payload ? 'google_key' and p_payload->>'google_key' <> s.google_key then
    return jsonb_build_object('ok', false, 'error', 'Wrong Google key');
  end if;

  -- The same sheet row sent again (retry / reinstall / "send everything") is answered, never counted twice.
  if v_row is not null and exists (select 1 from public.lead_source_events e where e.source_id = s.id and e.row_key = v_row and e.status <> 'error') then
    return jsonb_build_object('ok', true, 'status', 'already');
  end if;
  update public.lead_sources set last_attempt_at = now() where id = s.id;
  p_payload := p_payload - '_row_key' - '_row' - '_sheet';
  f := public.flatten_lead_payload(p_payload);
  v_ignore := coalesce(array(select jsonb_array_elements_text(s.field_map->'_ignore')), '{}');
  m := s.field_map;
  select phone_prefix, coalesce(timezone, 'Asia/Kolkata') into v_prefix, tz from public.organizations where id = s.org_id;

  -- Remember every heading with the sheet's own words (for lead details, filters and columns).
  if jsonb_typeof(p_payload) = 'object' then
    for k, v in select * from jsonb_each(p_payload) loop
      continue when jsonb_typeof(v) in ('object', 'array') or public.lead_key(k) = '' or k in ('is_test', 'google_key', 'api_version') or left(k, 1) = '_';
      insert into public.lead_fields (org_id, key, label, seen_count)
      values (s.org_id, public.lead_key(k), left(regexp_replace(trim(k), '\s+', ' ', 'g'), 80), 1)
      on conflict (org_id, key) do update set seen_count = public.lead_fields.seen_count + 1, last_seen = now(),
        -- a label made from the key earlier is replaced by the sheet's real heading ("Date & Time")
        label = case when public.lead_fields.label = initcap(replace(public.lead_fields.key, '_', ' ')) then excluded.label else public.lead_fields.label end;
    end loop;
  end if;

  v_first := public.pick_lead_field(f, m, 'first_name', array['first_name', 'firstname', 'fname', 'given_name']);
  v_last := public.pick_lead_field(f, m, 'last_name', array['last_name', 'lastname', 'lname', 'family_name', 'surname']);
  v_name := coalesce(public.pick_lead_field(f, m, 'name', array['full_name', 'fullname', 'name', 'your_name', 'customer_name', 'contact_name', 'lead_name', 'sender_name']),
                     nullif(trim(concat_ws(' ', v_first, v_last)), ''), '');
  v_phone := public.normalize_phone(public.pick_lead_field(f, m, 'phone', array['phone_number', 'phone', 'mobile', 'mobile_number', 'mobile_no', 'contact', 'contact_number',
               'whatsapp', 'whatsapp_number', 'phone_no', 'cell', 'telephone', 'number', 'sender_mobile', 'user_phone']), v_prefix);
  v_email := lower(public.pick_lead_field(f, m, 'email', array['email', 'email_address', 'e_mail', 'mail', 'your_email', 'sender_email', 'user_email', 'email_id']));

  if coalesce((p_payload->>'is_test')::boolean, false) then
    insert into public.lead_source_events (source_id, org_id, payload, status) values (s.id, s.org_id, p_payload, 'test');
    update public.lead_sources set last_received_at = now() where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'test');
  end if;

  -- A row with no phone, no email and no name is not a lead (blank row, a row with only a team member's name, a heading…).
  if coalesce(v_phone, '') = '' and coalesce(v_email, '') = '' and coalesce(v_name, '') = '' then
    insert into public.lead_source_events (source_id, org_id, payload, status, error, row_key)
    values (s.id, s.org_id, p_payload, 'skipped', 'Not a lead: no name, phone or email', v_row);
    update public.lead_sources set n_skipped = n_skipped + 1 where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'skipped');
  end if;
  if not public.phone_is_valid(v_phone) then
    insert into public.lead_source_events (source_id, org_id, payload, status, error, row_key)
    values (s.id, s.org_id, p_payload, 'invalid', 'Phone number missing or not valid', v_row);
    update public.lead_sources set n_invalid = n_invalid + 1, last_received_at = now() where id = s.id;
    return jsonb_build_object('ok', false, 'status', 'invalid', 'error', 'Phone number missing or not valid');
  end if;

  select coalesce(jsonb_object_agg(k2, v2), '{}'::jsonb) into v_custom
  from jsonb_each_text(f) as e(k2, v2)
  where not k2 = any(std) and v2 <> '' and k2 not like '%.%' and k2 not in ('google_key', 'api_version', 'is_test', 'lead_id', 'form_id', 'gcl_id', 'adgroup_id', 'creative_id') and not k2 = any(v_ignore) and left(k2, 1) <> '_';

  -- Sign-up time from the sheet ("Date & Time", "Timestamp", …); else now.
  v_signup := public.parse_any_date(public.pick_lead_field(f, m, 'signup_at',
    array['date_time', 'datetime', 'timestamp', 'time_stamp', 'submitted_at', 'submission_date', 'created_time', 'date_created', 'registered_at', 'registration_date', 'date']), tz);
  if v_signup is not null and (v_signup > now() + interval '1 day' or v_signup < now() - interval '5 years') then v_signup := null; end if;

  -- Webinar: picked for the source, or read from a column of the sheet.
  if s.webinar_mode = 'column' and coalesce(s.webinar_column, '') <> '' then
    v_batch := public.batch_for_text(s.org_id, f->>public.lead_key(s.webinar_column), s.id);
  else
    v_batch := s.batch_id;
  end if;

  -- "Team Member" column with a team member's name → that person.
  v_member := public.member_by_name(s.org_id,
    case when coalesce(s.member_column, '') <> '' then f->>public.lead_key(s.member_column)
      else public.pick_lead_field(f, '{}'::jsonb, 'x', array['team_member', 'assigned_to', 'assigned', 'assigned_name', 'assign_to', 'agent', 'assignee', 'sales_person', 'salesperson', 'caller', 'owner', 'rep', 'counsellor', 'counselor']) end);

  v_lead := public.find_lead(s.org_id, v_phone, v_email);

  if v_lead is not null then
    -- This source already delivered this person (and they're already in this webinar): the same registration sent again,
    -- e.g. after the script was reinstalled. Remember the row, count nothing.
    if exists (select 1 from public.lead_source_events e where e.source_id = s.id and e.lead_id = v_lead and e.status in ('created', 'duplicate', 'joined'))
       and (v_batch is null or exists (select 1 from public.batch_leads b where b.batch_id = v_batch and b.lead_id = v_lead)) then
      insert into public.lead_source_events (source_id, org_id, payload, status, lead_id, row_key) values (s.id, s.org_id, p_payload, 'already', v_lead, v_row);
      update public.lead_sources set last_success_at = now() where id = s.id;
      return jsonb_build_object('ok', true, 'status', 'already', 'lead_id', v_lead);
    end if;
    v_status := 'duplicate';
    perform public.lead_arrived(v_lead, 'webhook', coalesce(s.source_label, s.name),
      coalesce(public.pick_lead_field(f, m, 'campaign', array['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']), s.campaign), v_batch,
      jsonb_build_object('name', v_name, 'email', v_email, 'phone', v_phone,
        'city', public.pick_lead_field(f, m, 'city', array['city', 'town', 'location']),
        'profession', public.pick_lead_field(f, m, 'profession', array['profession', 'occupation', 'job_title', 'what_do_you_do', 'industry', 'business_type', 'work'])));
    -- New sheet columns fill in (never overwrite what the team typed).
    update public.leads set custom = v_custom || coalesce(custom, '{}'::jsonb) where id = v_lead;
    if v_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, reminder_by)
      values (v_batch, v_lead, s.org_id, true, (select assigned_to from public.leads where id = v_lead))
      on conflict (batch_id, lead_id) do nothing;
      if found then
        v_status := 'joined';
        insert into public.lead_activities (org_id, lead_id, kind, data)
        values (s.org_id, v_lead, 'batch_joined', jsonb_build_object('batch_id', v_batch, 'repeat', true, 'source', s.name));
      end if;
    end if;
  else
    -- Who gets it: the sheet's team member > the ticked people in turn > one person > the company's rules.
    if v_member is not null then
      v_assign := v_member;
    elsif s.assign_mode = 'users' then
      select array_agg(u order by ord) into v_users
      from unnest(s.assign_users) with ordinality as x(u, ord)
      where exists (select 1 from public.org_members om where om.org_id = s.org_id and om.user_id = x.u and om.status = 'active');
      n := coalesce(array_length(v_users, 1), 0);
      if n > 0 then
        update public.lead_sources set rr_pos = rr_pos + 1 where id = s.id returning rr_pos into s.rr_pos;
        v_assign := v_users[((s.rr_pos - 1) % n) + 1];
      end if;
    elsif s.assign_mode = 'user' then
      v_assign := s.assign_to;
    end if;
    if v_assign is not null or s.assign_mode <> 'rules' then perform set_config('closeros.skip_distribution', 'on', true); end if;
    insert into public.leads (org_id, name, phone, email, city, state, profession, company, source, campaign, notes, custom, assigned_to, signup_at)
    values (
      s.org_id, v_name, v_phone, v_email,
      public.pick_lead_field(f, m, 'city', array['city', 'town', 'location', 'city_location']),
      public.pick_lead_field(f, m, 'state', array['state', 'region', 'province', 'state_ut']),
      public.pick_lead_field(f, m, 'profession', array['profession', 'occupation', 'job_title', 'what_do_you_do', 'industry', 'business_type', 'work']),
      public.pick_lead_field(f, m, 'company', array['company', 'company_name', 'business_name', 'organisation', 'organization', 'sender_company']),
      coalesce(s.source_label, s.name),
      coalesce(public.pick_lead_field(f, m, 'campaign', array['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']), s.campaign),
      public.pick_lead_field(f, m, 'notes', array['message', 'notes', 'comments', 'query', 'enquiry', 'requirement', 'query_message']),
      v_custom, v_assign, coalesce(v_signup, now())
    ) returning id into v_lead;
    perform set_config('closeros.skip_distribution', 'off', true);
    v_minutes := nullif(regexp_replace(coalesce(public.pick_lead_field(f, m, 'watch_minutes', array['watch_minutes']), ''), '[^0-9]', '', 'g'), '')::int;
    if v_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, reminder_by)
      values (v_batch, v_lead, s.org_id, false, v_minutes, (select assigned_to from public.leads where id = v_lead))
      on conflict do nothing;
    end if;
    v_status := 'created';
  end if;

  insert into public.lead_source_events (source_id, org_id, payload, status, lead_id, row_key) values (s.id, s.org_id, p_payload, v_status, v_lead, v_row);
  update public.lead_sources set last_received_at = now(), last_success_at = now(),
    received_count = received_count + case when v_status = 'created' then 1 else 0 end,
    n_created = n_created + case when v_status = 'created' then 1 else 0 end,
    n_duplicate = n_duplicate + case when v_status in ('duplicate', 'joined') then 1 else 0 end where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_status, 'lead_id', v_lead, 'batch_id', v_batch);
exception when others then
  insert into public.lead_source_events (source_id, org_id, payload, status, error, row_key)
  values (s.id, s.org_id, p_payload, 'error', sqlerrm, v_row);
  update public.lead_sources set n_failed = n_failed + 1, last_error = left(sqlerrm, 200) where id = s.id;
  return jsonb_build_object('ok', false, 'error', 'Could not save this lead');
end $function$;


-- The sheet's script says hello every run: which sheet, how many rows, how far it has sent, whether its timer is set.
create or replace function public.sheet_hello(p_token text, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.lead_sources;
begin
  select * into s from public.lead_sources where token = p_token;
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'Unknown lead source'); end if;
  update public.lead_sources set sheet = coalesce(p, '{}'::jsonb) || jsonb_build_object('at', now()) where id = s.id;
  return jsonb_build_object('ok', true, 'active', s.is_active, 'name', s.name);
end $$;
revoke execute on function public.sheet_hello(text, jsonb) from public, anon, authenticated;

-- Try failed rows again (server problems only — invalid phones stay invalid until the sheet is fixed).
create or replace function public.retry_source_failures(p_source uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.lead_sources; e record; r jsonb; ok int := 0; bad int := 0;
begin
  select * into s from public.lead_sources where id = p_source;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Not allowed'; end if;
  for e in select id, payload, row_key from public.lead_source_events where source_id = p_source and status = 'error' order by id limit 500 loop
    delete from public.lead_source_events where id = e.id;
    update public.lead_sources set n_failed = greatest(n_failed - 1, 0) where id = p_source;
    r := public.ingest_lead(s.token, e.payload || case when e.row_key is null then '{}'::jsonb else jsonb_build_object('_row_key', e.row_key) end);
    if coalesce((r->>'ok')::boolean, false) then ok := ok + 1; else bad := bad + 1; end if;
  end loop;
  return jsonb_build_object('retried', ok + bad, 'saved', ok, 'still_failing', bad);
end $$;
grant execute on function public.retry_source_failures(uuid) to authenticated;

-- Give unassigned leads to the team member named in one of their columns (e.g. the sheet's "Assigned" = "Nikhil").
create or replace function public.assign_by_column(p_org uuid, p_key text, p_dry boolean default true) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; nomatch int := 0; per jsonb := '{}'::jsonb; names jsonb := '{}'::jsonb; u uuid;
begin
  if not public.is_org_manager(p_org) then raise exception 'Not allowed'; end if;
  for r in select id, custom->>p_key v from public.leads where org_id = p_org and deleted_at is null and assigned_to is null and coalesce(custom->>p_key, '') <> '' loop
    u := public.member_by_name(p_org, r.v);
    if u is null then nomatch := nomatch + 1; names := names || jsonb_build_object(r.v, coalesce((names->>r.v)::int, 0) + 1); continue; end if;
    n := n + 1; per := per || jsonb_build_object(u::text, coalesce((per->>u::text)::int, 0) + 1);
    if not p_dry then update public.leads set assigned_to = u, assigned_at = now() where id = r.id; end if;
  end loop;
  if not p_dry and n > 0 then perform public.write_audit(p_org, 'leads.assigned_by_column', 'lead', null, jsonb_build_object('key', p_key, 'count', n)); end if;
  return jsonb_build_object('assigned', n, 'per_user', per, 'not_matched', nomatch, 'unknown_names', names);
end $$;
grant execute on function public.assign_by_column(uuid, text, boolean) to authenticated;

-- Honest counters for existing sources, from what really happened.
update public.lead_source_events set status = 'invalid' where status = 'error' and error = 'No valid phone number found';
update public.lead_sources s set
  n_created = (select count(*) from public.lead_source_events e where e.source_id = s.id and e.status = 'created'),
  n_duplicate = (select count(*) from public.lead_source_events e where e.source_id = s.id and e.status in ('duplicate', 'joined')),
  n_invalid = (select count(*) from public.lead_source_events e where e.source_id = s.id and e.status = 'invalid'),
  n_failed = (select count(*) from public.lead_source_events e where e.source_id = s.id and e.status = 'error'),
  received_count = (select count(*) from public.lead_source_events e where e.source_id = s.id and e.status = 'created');

-- Each column's type (guessed from its values on the dashboard; the company can change it) for smarter filters.
alter table public.lead_fields add column if not exists ftype text not null default 'auto';

-- Many rows in one call (the sheet script sends 100 at a time): one round trip instead of 100.
create or replace function public.ingest_leads(p_token text, p_rows jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; out jsonb := '[]'::jsonb;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    out := out || jsonb_build_array(public.ingest_lead(p_token, case when jsonb_typeof(r) = 'object' then r else jsonb_build_object('value', r) end));
  end loop;
  return out;
end $$;
revoke execute on function public.ingest_leads(text, jsonb) from public, anon, authenticated;
