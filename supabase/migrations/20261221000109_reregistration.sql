-- Registered again (owner, Nov 2026): a person who registers for another webinar is really interested.
--  * has an owner → stays with that owner; unowned → the source's current rule.
--  * kept with an owner who isn't in the current rule → listed on the webinar (outside_rule) for bulk re-assign.
--  * the owner is told at once (push) and the phone says "registered again · Nth time".
--  * priority: registered 2× → at least Warm (40), 3×+ → Hot (70).
alter table public.batch_leads add column if not exists assign_how text, add column if not exists rule_pick uuid,
  add column if not exists outside_rule boolean not null default false;
alter table public.leads add column if not exists reg_count int not null default 0,
  add column if not exists reregistered_at timestamptz;

-- Who the source's rule gives a lead to: the sheet's team-member column > ticked people in turn > one person.
create or replace function public.source_rule_pick(s public.lead_sources, p_member uuid, p_advance boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_users uuid[]; n int; pos int;
begin
  if p_member is not null then return p_member; end if;
  if s.assign_mode = 'users' then
    select array_agg(u order by ord) into v_users from unnest(s.assign_users) with ordinality as x(u, ord)
    where exists (select 1 from public.org_members om where om.org_id = s.org_id and om.user_id = x.u and om.status = 'active');
    n := coalesce(array_length(v_users, 1), 0);
    if n = 0 then return null; end if;
    if p_advance then
      update public.lead_sources set rr_pos = rr_pos + 1 where id = s.id returning rr_pos into pos;
    else pos := s.rr_pos + 1; end if;
    return v_users[((pos - 1) % n) + 1];
  elsif s.assign_mode = 'user' then return s.assign_to;
  end if;
  return null;
end $$;
revoke all on function public.source_rule_pick(public.lead_sources, uuid, boolean) from public, anon, authenticated;

-- Wake one person's phone (Firebase) so the "new lead / registered again" notification shows at once.
create or replace function public.push_wake(p_org uuid, p_user uuid, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or not exists (select 1 from public.push_tokens t where t.user_id = p_user) then return; end if;
  perform net.http_post(
    url := 'https://tdbqgoxxxfkfttdznzhb.supabase.co/functions/v1/push',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'indiamart_cron_secret')),
    body := jsonb_build_object('org', p_org, 'users', jsonb_build_array(p_user), 'kind', p_kind), timeout_milliseconds := 10000);
exception when others then null;  -- a lead must never fail because a phone couldn't be woken
end $$;
revoke all on function public.push_wake(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.push_targets_service(p_users uuid[])
returns table(user_id uuid, device_id text, token text) language sql stable security definer set search_path = '' as $$
  select t.user_id, t.device_id, t.token from public.push_tokens t where t.user_id = any(p_users)
$$;
revoke all on function public.push_targets_service(uuid[]) from public, anon, authenticated;
grant execute on function public.push_targets_service(uuid[]) to service_role;

-- Registration count + priority floor for one lead's webinar rows.
create or replace function public.reg_floor_lead(p_lead uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  select count(*) into n from public.batch_leads bl join public.batches b on b.id = bl.batch_id
  where bl.lead_id = p_lead and not b.is_archived and coalesce(bl.registered, true);
  update public.leads set reg_count = n where id = p_lead and reg_count is distinct from n;
  if n < 2 then return; end if;
  update public.batch_leads bl set
    warmth = greatest(coalesce(bl.warmth, 0), case when n >= 3 then 70 else 40 end),
    warm_reason = case
      when coalesce(bl.warmth, 0) < case when n >= 3 then 70 else 40 end
        then (case when n >= 3 then '🔥 Hot · 70' else 'Warm · 40' end) || ' · 🔁 registered ' || n || '×'
          || coalesce(' · ' || nullif(regexp_replace(coalesce(bl.warm_reason, ''), '^[^·]*·[^·]*(·\s*)?', ''), ''), '')
      when coalesce(bl.warm_reason, '') ~ '🔁 registered' then regexp_replace(bl.warm_reason, '🔁 registered \d+×', '🔁 registered ' || n || '×')
      else coalesce(bl.warm_reason, '') || ' · 🔁 registered ' || n || '×' end
  where bl.lead_id = p_lead;
end $$;
revoke all on function public.reg_floor_lead(uuid) from public, anon, authenticated;

create or replace function public.t_bl_reg_count() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.reg_floor_lead(coalesce(new.lead_id, old.lead_id));
  return null;
end $$;
drop trigger if exists t_bl_reg_count on public.batch_leads;
create trigger t_bl_reg_count after insert or delete or update of registered on public.batch_leads
  for each row execute function public.t_bl_reg_count();

-- Owner kept the lead but isn't one of the people the current rule names → flag for the webinar list.
create or replace function public.t_bl_outside_rule() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assign_how = 'previous_owner' and new.rule_pick is not null and new.reminder_by is not null
     and new.rule_pick <> new.reminder_by then
    new.outside_rule := not exists (
      select 1 from public.lead_sources s join public.batches b on b.source_id = s.id
      where b.id = new.batch_id and s.assign_mode = 'users' and new.reminder_by = any(s.assign_users)
        and coalesce(s.member_column, '') = '');
  end if;
  return new;
end $$;
drop trigger if exists t_bl_outside_rule on public.batch_leads;
create trigger t_bl_outside_rule before insert on public.batch_leads for each row execute function public.t_bl_outside_rule();

-- New leads + registered-again leads for the phone's notification.
drop function if exists public.my_new_leads(uuid, timestamptz);
create function public.my_new_leads(p_org uuid, p_since timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with nw as (
    select l.* from public.leads l
    where l.org_id = p_org and l.assigned_to = auth.uid() and l.deleted_at is null and l.assigned_at > p_since
  ), ag as (
    select l.* from public.leads l
    where l.org_id = p_org and l.assigned_to = auth.uid() and l.deleted_at is null and l.reregistered_at > p_since
      and l.reg_count >= 2 and not exists (select 1 from nw where nw.id = l.id and nw.reg_count < 2)
  )
  select jsonb_build_object(
    'count', (select count(*) from nw where nw.id not in (select id from ag)),
    'names', coalesce((select (array_agg(coalesce(nullif(name, ''), phone) order by assigned_at desc))[1:3] from nw where nw.id not in (select id from ag)), '{}'),
    'again_count', (select count(*) from ag),
    'again', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', coalesce(nullif(name, ''), phone), 'times', reg_count) order by reregistered_at desc)
                       from (select * from ag order by reregistered_at desc limit 3) x), '[]'),
    'latest', greatest((select max(assigned_at) from nw), (select max(reregistered_at) from ag)))
$$;
grant execute on function public.my_new_leads(uuid, timestamptz) to authenticated;

-- Webinar cards: "Called" = leads with a call FOR THIS webinar (not any call ever).
drop function if exists public.batch_cards(uuid);
create function public.batch_cards(p_org uuid)
returns table(id uuid, name text, kind text, webinar_at timestamptz, auto_created boolean, zoom_uploaded boolean, registered int,
  assigned int, unassigned int, called int, attended int, hot int, repeats int, rem_called int, rem_talked int, rem_calls int,
  rem_by jsonb, again int, outside_rule int)
language sql stable security definer set search_path = '' as $$
  with rc as (
    select c.batch_id, c.lead_id, c.user_id, c.duration_sec from public.calls c
    join public.batches b on b.id = c.batch_id
    where c.org_id = p_org and c.purpose = 'reminder' and not b.is_archived and c.started_at < b.webinar_at
  ), anyc as (
    select distinct c.batch_id, c.lead_id from public.calls c join public.batches b on b.id = c.batch_id
    where c.org_id = p_org and not b.is_archived
  ), per as (
    select batch_id, user_id, count(distinct lead_id) leads, count(*) calls,
      count(distinct lead_id) filter (where duration_sec > 30) talked from rc group by 1, 2
  )
  select b.id, b.name, b.kind, b.webinar_at, b.auto_created, b.zoom_uploaded_at is not null,
    count(l.id)::int,
    count(l.id) filter (where l.assigned_to is not null)::int,
    count(l.id) filter (where l.assigned_to is null)::int,
    count(l.id) filter (where exists (select 1 from anyc where anyc.batch_id = b.id and anyc.lead_id = l.id))::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) > 0 or coalesce(bl.attended, false))::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) >= b.hot_minutes or coalesce(bl.warmth, 0) >= 70)::int,
    count(l.id) filter (where bl.is_repeat)::int,
    count(l.id) filter (where exists (select 1 from rc where rc.batch_id = b.id and rc.lead_id = l.id))::int,
    count(l.id) filter (where exists (select 1 from rc where rc.batch_id = b.id and rc.lead_id = l.id and rc.duration_sec > 30))::int,
    (select count(*) from rc where rc.batch_id = b.id)::int,
    coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'leads', p.leads, 'calls', p.calls, 'talked', p.talked) order by p.leads desc)
      from per p where p.batch_id = b.id), '[]'),
    count(l.id) filter (where l.reg_count >= 2)::int,
    count(l.id) filter (where bl.outside_rule and l.assigned_to = bl.reminder_by)::int
  from public.batches b
  left join public.batch_leads bl on bl.batch_id = b.id and not coalesce(bl.is_holdout, false)
  left join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  where b.org_id = p_org and not b.is_archived and public.is_org_manager(p_org)
  group by b.id
  order by b.webinar_at desc
$$;
grant execute on function public.batch_cards(uuid) to authenticated;

-- Leads kept with an owner who isn't in the current rule (webinar card list).
create or replace function public.batch_outside_rule(p_batch uuid)
returns table(lead_id uuid, name text, phone text, owner uuid, rule_pick uuid, times int, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.id, l.name, l.phone, l.assigned_to, bl.rule_pick, l.reg_count, l.reregistered_at
  from public.batch_leads bl join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  join public.batches b on b.id = bl.batch_id
  where bl.batch_id = p_batch and bl.outside_rule and l.assigned_to = bl.reminder_by and public.is_org_manager(b.org_id)
  order by l.reregistered_at desc nulls last
$$;
grant execute on function public.batch_outside_rule(uuid) to authenticated;
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
  v_custom jsonb; v_batch uuid; v_row text := nullif(p_payload->>'_row_key', ''); v_ignore text[]; v_digits text; v_signup timestamptz; v_member uuid; v_assign uuid; v_owner uuid; v_pick uuid; v_how text; k text; v jsonb;
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
    v_batch := public.batch_for_text(s.org_id, f->>public.lead_key(s.webinar_column), s.id, v_signup);
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
    -- A new registration for a webinar this person isn't in yet = they came back (real interest).
    -- Owner rule (owner, Nov 2026): a lead that has an owner STAYS with that owner; an unowned lead goes by the source's current rule.
    if v_batch is not null and not exists (select 1 from public.batch_leads b where b.batch_id = v_batch and b.lead_id = v_lead) then
      select assigned_to into v_owner from public.leads where id = v_lead;
      v_pick := public.source_rule_pick(s, v_member, v_owner is null);
      if v_owner is null then
        if v_pick is null and s.assign_mode = 'rules' then
          v_pick := public.pick_assignee(s.org_id, (select l from public.leads l where l.id = v_lead));
        end if;
        if v_pick is not null then
          update public.leads set assigned_to = v_pick, assigned_at = now() where id = v_lead;
        end if;
        v_how := 'rule';
      else
        v_how := 'previous_owner';
      end if;
    end if;
    perform public.lead_arrived(v_lead, 'webhook', coalesce(s.source_label, s.name),
      coalesce(public.pick_lead_field(f, m, 'campaign', array['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']), s.campaign), v_batch,
      jsonb_build_object('name', v_name, 'email', v_email, 'phone', v_phone,
        'city', public.pick_lead_field(f, m, 'city', array['city', 'town', 'location']),
        'profession', public.pick_lead_field(f, m, 'profession', array['profession', 'occupation', 'job_title', 'what_do_you_do', 'industry', 'business_type', 'work'])));
    -- New sheet columns fill in (never overwrite what the team typed).
    update public.leads set custom = v_custom || coalesce(custom, '{}'::jsonb) where id = v_lead;
    if v_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, reminder_by, assign_how, rule_pick)
      values (v_batch, v_lead, s.org_id, true, (select assigned_to from public.leads where id = v_lead), v_how, v_pick)
      on conflict (batch_id, lead_id) do nothing;
      if found then
        v_status := 'joined';
        insert into public.lead_activities (org_id, lead_id, kind, data)
        values (s.org_id, v_lead, 'batch_joined', jsonb_build_object('batch_id', v_batch, 'repeat', true, 'source', s.name));
        -- tell the owner at once: "registered again"
        update public.leads set reregistered_at = now() where id = v_lead and assigned_to is not null;
        perform public.push_wake(s.org_id, (select assigned_to from public.leads where id = v_lead), 'leads');
      end if;
    end if;
  else
    -- Who gets it: the sheet's team member > the ticked people in turn > one person > the company's rules.
    v_assign := public.source_rule_pick(s, v_member, true);
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
    perform public.push_wake(s.org_id, (select assigned_to from public.leads where id = v_lead), 'leads');
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
end $function$

;

-- keep the registered-again priority after warmth is recomputed
CREATE OR REPLACE FUNCTION public.batch_recompute(p_batch uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b record; v_pitch_at timestamptz; v_ref int;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null then return; end if;
  v_pitch_at := case when b.pitch_minute is null then null
                     else coalesce(b.started_at, b.webinar_at) + make_interval(mins => b.pitch_minute) end;
  v_ref := greatest(coalesce(b.pitch_minute, b.hot_minutes, 60), 1);

  update public.batch_leads bl set
    chat_count = (select count(*) from public.batch_chat c where c.batch_id = p_batch and c.lead_id = bl.lead_id),
    poll_answered = (select count(distinct p.question) from public.batch_poll_answers p where p.batch_id = p_batch and p.lead_id = bl.lead_id)
  where bl.batch_id = p_batch;

  update public.batch_leads bl set
    at_pitch = case when v_pitch_at is null or bl.sessions is null or jsonb_array_length(bl.sessions) = 0 then null
                    else exists (select 1 from jsonb_array_elements(bl.sessions) s
                                 where (s->>'join')::timestamptz <= v_pitch_at and (s->>'leave')::timestamptz >= v_pitch_at) end
  where bl.batch_id = p_batch;

  update public.batch_leads bl set
    saw_pitch = case when b.pitch_minute is null or bl.watch_minutes is null then null
                     when coalesce(bl.watch_minutes, 0) = 0 then false
                     else coalesce(bl.at_pitch, bl.watch_minutes >= b.pitch_minute) end
  where bl.batch_id = p_batch;

  update public.batch_leads bl set warmth = x.score, warm_reason = x.reason
  from (
    select bl2.lead_id,
      case when coalesce(bl2.watch_minutes, 0) = 0 and bl2.chat_count = 0 and bl2.poll_answered = 0 then 0 else least(100, round(
        least(coalesce(bl2.watch_minutes, 0)::numeric / v_ref, 1) * 40
        + case when bl2.saw_pitch then 25 else 0 end
        + case when bl2.chat_count >= 2 then 15 when bl2.chat_count = 1 then 10 else 0 end
        + case when bl2.poll_answered > 0 then 10 + least(bl2.poll_answered, 4) * 2.5 else 0 end))::int end score,
      bl2.watch_minutes w, bl2.saw_pitch sp, bl2.chat_count cc, bl2.poll_answered pa
    from public.batch_leads bl2 where bl2.batch_id = p_batch
  ) y, lateral (select y.score, case when y.score = 0 then null else
      (case when y.score >= 70 then '🔥 Hot' when y.score >= 40 then 'Warm' else 'Cold' end) || ' · ' || y.score
      || coalesce(' · watched ' || nullif(y.w, 0) || ' min', '')
      || case when y.sp then ' · saw the pitch' when y.sp = false and coalesce(y.w, 0) > 0 then ' · missed the pitch' else '' end
      || case when y.cc > 0 then ' · ' || y.cc || ' chat' || case when y.cc > 1 then 's' else '' end else '' end
      || case when y.pa > 0 then ' · answered ' || y.pa || ' poll' || case when y.pa > 1 then 's' else '' end else '' end end reason) x
  where bl.batch_id = p_batch and bl.lead_id = y.lead_id;

  perform public.reg_floor_lead(x.lead_id) from (select distinct lead_id from public.batch_leads where batch_id = p_batch) x;
  -- leads.updated_at moves so phones re-download the lead with its new warmth.
  update public.leads l set updated_at = now()
  where l.id in (select lead_id from public.batch_leads where batch_id = p_batch);
end $function$

;

-- Backfill: registration counts + priority for everyone who registered 2+ times.
do $$ declare r record; begin
  for r in select lead_id from public.batch_leads group by lead_id having count(*) >= 1 loop
    perform public.reg_floor_lead(r.lead_id);
  end loop;
end $$;

-- Repair: unowned leads in UPCOMING webinars whose sheet row names a team member → that person (older ones: owner decides).
with fix as (
  select distinct on (l.id) l.id, public.member_by_name(l.org_id, e.payload->>s.member_column) u
  from public.leads l
  join public.lead_source_events e on e.lead_id = l.id
  join public.lead_sources s on s.id = e.source_id
  where l.assigned_to is null and l.deleted_at is null and coalesce(s.member_column, '') <> ''
    and coalesce(e.payload->>s.member_column, '') <> ''
    and exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
                where bl.lead_id = l.id and not b.is_archived and b.webinar_at > now())
  order by l.id, e.received_at desc
)
update public.leads l set assigned_to = fix.u, assigned_at = now() from fix where fix.id = l.id and fix.u is not null;
