-- Leads from sheets / webhooks, made simple (owner, Nov 2026):
--  · every heading of the sheet becomes a named lead field (lead_fields keeps the sheet's own label)
--  · "Date & Time" (or similar) = the lead's sign-up time (leads.signup_at; newest sign-ups first on the dashboard)
--  · a "Team Member" column with a team member's name assigns the lead to that person
--  · "who gets new leads": tick people → each new lead goes to the next one in turn (assign_mode 'users')
--  · webinars: either picked by hand for the source (as before) or taken from a column of the sheet
--    ("4th Oct - 2026" → the webinar of 4 Oct, created automatically if it doesn't exist yet)
--  · webinars can be deleted (leads stay); after the webinar, assign_batch_leads() shares out sales calls.

-- ───── Field registry ─────
create table if not exists public.lead_fields (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  label text not null,
  seen_count int not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  hidden boolean not null default false,
  primary key (org_id, key)
);
alter table public.lead_fields enable row level security;
drop policy if exists lead_fields_select on public.lead_fields;
create policy lead_fields_select on public.lead_fields for select using (public.is_org_member(org_id));
drop policy if exists lead_fields_write on public.lead_fields;
create policy lead_fields_write on public.lead_fields for all using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));

-- Fields already stored on leads (custom) get a registry row, labelled from the key.
insert into public.lead_fields (org_id, key, label, seen_count)
select l.org_id, k, initcap(replace(k, '_', ' ')), count(*)
from public.leads l, jsonb_object_keys(coalesce(l.custom, '{}'::jsonb)) k
where l.deleted_at is null
group by l.org_id, k
on conflict do nothing;

-- ───── Columns ─────
alter table public.leads add column if not exists signup_at timestamptz;
create index if not exists leads_org_signup on public.leads (org_id, signup_at desc) where deleted_at is null;

alter table public.lead_sources add column if not exists webinar_mode text not null default 'fixed';
alter table public.lead_sources drop constraint if exists lead_sources_webinar_mode_check;
alter table public.lead_sources add constraint lead_sources_webinar_mode_check check (webinar_mode in ('fixed', 'column'));
alter table public.lead_sources add column if not exists webinar_column text;
alter table public.lead_sources add column if not exists webinar_time time not null default '19:00';
alter table public.lead_sources add column if not exists webinar_prefix text not null default 'Webinar';
alter table public.lead_sources add column if not exists assign_users uuid[] not null default '{}';
alter table public.lead_sources add column if not exists rr_pos int not null default 0;
alter table public.lead_sources add column if not exists member_column text;   -- null = look for "Team Member" etc.
alter table public.lead_sources drop constraint if exists lead_sources_assign_mode_check;
alter table public.lead_sources add constraint lead_sources_assign_mode_check check (assign_mode in ('rules', 'user', 'users', 'none'));

alter table public.batches add column if not exists source_id uuid references public.lead_sources(id) on delete set null;
alter table public.batches add column if not exists auto_created boolean not null default false;

-- Who is in the reminder team / sales team (only used when a company works with two teams).
alter table public.org_members add column if not exists call_team text;
alter table public.org_members drop constraint if exists org_members_call_team_check;
alter table public.org_members add constraint org_members_call_team_check check (call_team is null or call_team in ('reminder', 'sales'));

-- ───── Helpers ─────
-- "4th Oct - 2026", "04/10/2026", "4 Oct 2026 7 PM", "2026-10-04 19:00" → the moment, and whether a time was given.
create or replace function public.webinar_parse(raw text, tz text default 'Asia/Kolkata', out at timestamptz, out has_time boolean)
language plpgsql stable set search_path = '' as $$
declare s text; m text[]; hh int; mi int; pm text; d timestamptz;
begin
  has_time := false;
  s := lower(trim(coalesce(raw, '')));
  if s = '' then return; end if;
  s := regexp_replace(s, '(\d)(st|nd|rd|th)\M', '\1', 'g');          -- 4th → 4
  -- a time anywhere: 7 pm, 7:30pm, 19:00
  m := regexp_match(s, '(\d{1,2})(?::(\d{2}))?\s*(am|pm)\M');
  if m is null then m := regexp_match(s, '(?:^|[^\d/.\-])(\d{1,2}):(\d{2})(?!\d)'); end if;
  if m is not null then
    hh := m[1]::int; mi := coalesce(m[2]::int, 0); pm := m[3];
    if pm = 'pm' and hh < 12 then hh := hh + 12; elsif pm = 'am' and hh = 12 then hh := 0; end if;
    if hh between 0 and 23 and mi between 0 and 59 then has_time := true; end if;
  end if;
  -- the date part: drop the time and tidy separators
  s := regexp_replace(s, '\d{1,2}(:\d{2})?(:\d{2})?\s*(am|pm)\M', ' ', 'g');
  s := regexp_replace(s, '(^|\s)\d{1,2}:\d{2}(:\d{2})?', ' ', 'g');
  s := trim(regexp_replace(regexp_replace(s, '[,]', ' ', 'g'), '\s+-\s*|-\s+', ' ', 'g'));
  s := regexp_replace(s, '\s+', ' ', 'g');
  d := public.parse_any_date(s, tz);
  if d is null then has_time := false; return; end if;
  if has_time then
    at := make_timestamptz(extract(year from d at time zone tz)::int, extract(month from d at time zone tz)::int,
      extract(day from d at time zone tz)::int, hh, mi, 0, tz);
  else
    at := d;
  end if;
end $$;

-- The org's webinar on that day (one per date), created when it doesn't exist yet.
create or replace function public.batch_for_text(p_org uuid, p_raw text, p_source uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare tz text; w record; v_day date; v_id uuid; v_time time := '19:00'; v_prefix text := 'Webinar';
begin
  select coalesce(timezone, 'Asia/Kolkata') into tz from public.organizations where id = p_org;
  if p_source is not null then
    select webinar_time, webinar_prefix into v_time, v_prefix from public.lead_sources where id = p_source;
  end if;
  select * into w from public.webinar_parse(p_raw, tz);
  if w.at is null then return null; end if;
  v_day := (w.at at time zone tz)::date;
  select id into v_id from public.batches
  where org_id = p_org and not is_archived and (webinar_at at time zone tz)::date = v_day
  order by (kind = 'webinar') desc, auto_created, created_at limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.batches (org_id, name, kind, webinar_at, source_id, auto_created)
  values (p_org, coalesce(nullif(trim(v_prefix), ''), 'Webinar') || ' · ' || to_char(v_day, 'FMDD Mon YYYY'), 'webinar',
    case when w.has_time then w.at else (v_day + coalesce(v_time, '19:00'::time)) at time zone tz end, p_source, true)
  returning id into v_id;
  return v_id;
end $$;

-- A team member by what someone typed: full name, first name, or email (only active members; a unique match).
create or replace function public.member_by_name(p_org uuid, p_raw text) returns uuid
language sql stable security definer set search_path = '' as $$
  with q as (select lower(trim(coalesce(p_raw, ''))) t),
  c as (
    select m.user_id, lower(trim(coalesce(p.full_name, ''))) fn, lower(coalesce(p.email, '')) em
    from public.org_members m join public.profiles p on p.id = m.user_id
    where m.org_id = p_org and m.status = 'active'
  )
  select coalesce(
    (select user_id from c, q where q.t <> '' and (c.fn = q.t or c.em = q.t) limit 1),
    (select max(user_id::text)::uuid from c, q where q.t <> '' and split_part(c.fn, ' ', 1) = split_part(q.t, ' ', 1)
       having count(*) = 1)
  )
$$;

-- ───── ingest_lead: fields, sign-up time, team member, round-robin, webinar from a column ─────
create or replace function public.ingest_lead(p_token text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  s public.lead_sources; f jsonb; m jsonb; v_prefix text; tz text;
  v_name text; v_phone text; v_email text; v_first text; v_last text; v_status text; v_lead uuid; v_minutes int;
  std text[] := array['name','full_name','fullname','first_name','last_name','phone','phone_number','mobile','email'];
  v_custom jsonb; v_batch uuid; v_signup timestamptz; v_member uuid; v_assign uuid; v_users uuid[]; n int; k text; v jsonb;
begin
  select * into s from public.lead_sources where token = p_token;
  if s.id is null or not s.is_active then
    return jsonb_build_object('ok', false, 'error', 'Unknown or paused lead source');
  end if;
  if s.google_key is not null and s.google_key <> '' and p_payload ? 'google_key' and p_payload->>'google_key' <> s.google_key then
    return jsonb_build_object('ok', false, 'error', 'Wrong Google key');
  end if;

  f := public.flatten_lead_payload(p_payload);
  m := s.field_map;
  select phone_prefix, coalesce(timezone, 'Asia/Kolkata') into v_prefix, tz from public.organizations where id = s.org_id;

  -- Remember every heading with the sheet's own words (for lead details, filters and columns).
  if jsonb_typeof(p_payload) = 'object' then
    for k, v in select * from jsonb_each(p_payload) loop
      continue when jsonb_typeof(v) in ('object', 'array') or public.lead_key(k) = '' or k in ('is_test', 'google_key', 'api_version');
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

  if v_phone is null or length(v_phone) < 8 then
    insert into public.lead_source_events (source_id, org_id, payload, status, error)
    values (s.id, s.org_id, p_payload, 'error', 'No valid phone number found');
    update public.lead_sources set last_received_at = now(), received_count = received_count + 1 where id = s.id;
    return jsonb_build_object('ok', false, 'error', 'No valid phone number found');
  end if;

  select coalesce(jsonb_object_agg(k2, v2), '{}'::jsonb) into v_custom
  from jsonb_each_text(f) as e(k2, v2)
  where not k2 = any(std) and v2 <> '' and k2 not like '%.%' and k2 not in ('google_key', 'api_version', 'is_test', 'lead_id', 'form_id', 'gcl_id', 'adgroup_id', 'creative_id');

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
      else public.pick_lead_field(f, '{}'::jsonb, 'x', array['team_member', 'assigned_to', 'assignee', 'sales_person', 'salesperson', 'caller', 'owner', 'rep', 'counsellor', 'counselor']) end);

  v_lead := public.find_lead(s.org_id, v_phone, v_email);

  if v_lead is not null then
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

  insert into public.lead_source_events (source_id, org_id, payload, status, lead_id) values (s.id, s.org_id, p_payload, v_status, v_lead);
  update public.lead_sources set last_received_at = now(), received_count = received_count + 1 where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_status, 'lead_id', v_lead, 'batch_id', v_batch);
exception when others then
  insert into public.lead_source_events (source_id, org_id, payload, status, error)
  values (s.id, s.org_id, p_payload, 'error', sqlerrm);
  return jsonb_build_object('ok', false, 'error', 'Could not save this lead');
end $function$;

-- ───── After the webinar: share out the calls ─────
-- p: {attendees: bool, attendee_users: [uuid], non_attendees: 'sales'|'reminder'|'none', non_attendee_users: [uuid],
--     only_unassigned: bool (default false), dry_run: bool}
-- Hottest first, dealt in turns → every person gets the same share of hot leads. Repeat leads keep their earlier owner
-- when that person is one of the people picked. Non-attendees sent back get the tag "Non-attendee · 4 Oct".
create or replace function public.assign_batch_leads(p_batch uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.batches; tz text; v_att uuid[]; v_non uuid[]; r record; i int := 0; j int := 0; n_att int; n_non int;
  v_to uuid; moved int := 0; kept int := 0; tagged int := 0; v_tag text; dry boolean := coalesce((p->>'dry_run')::boolean, false);
  per jsonb := '{}'::jsonb; mode_non text := coalesce(p->>'non_attendees', 'none');
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null or not public.is_org_manager(b.org_id) then raise exception 'Only managers can assign leads'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into tz from public.organizations where id = b.org_id;
  v_tag := 'Non-attendee · ' || to_char(b.webinar_at at time zone tz, 'FMDD Mon');
  select coalesce(array_agg(x::uuid), '{}') into v_att from jsonb_array_elements_text(coalesce(p->'attendee_users', '[]')) x;
  select coalesce(array_agg(x::uuid), '{}') into v_non from jsonb_array_elements_text(coalesce(p->'non_attendee_users', '[]')) x;
  if mode_non = 'sales' then v_non := v_att; end if;
  n_att := coalesce(array_length(v_att, 1), 0); n_non := coalesce(array_length(v_non, 1), 0);

  for r in
    select l.id, l.assigned_to, bl.is_repeat, coalesce(bl.watch_minutes, 0) > 0 or coalesce(bl.attended, false) attended,
      coalesce(bl.warmth, 0) warmth, coalesce(bl.watch_minutes, 0) mins
    from public.batch_leads bl join public.leads l on l.id = bl.lead_id
    where bl.batch_id = p_batch and l.deleted_at is null and not coalesce(l.do_not_call, false)
      and (not coalesce((p->>'only_unassigned')::boolean, false) or l.assigned_to is null)
    order by warmth desc, mins desc, l.id
  loop
    v_to := null;
    if r.attended and coalesce((p->>'attendees')::boolean, true) and n_att > 0 then
      if r.is_repeat and r.assigned_to = any(v_att) then v_to := r.assigned_to; kept := kept + 1;
      else v_to := v_att[(i % n_att) + 1]; i := i + 1; end if;
    elsif not r.attended and mode_non <> 'none' and n_non > 0 then
      if r.is_repeat and r.assigned_to = any(v_non) then v_to := r.assigned_to; kept := kept + 1;
      else v_to := v_non[(j % n_non) + 1]; j := j + 1; end if;
      if mode_non = 'reminder' and not dry then
        update public.leads set tags = (select array_agg(distinct t) from unnest(coalesce(tags, '{}') || v_tag) t) where id = r.id;
        tagged := tagged + 1;
      end if;
    end if;
    continue when v_to is null;
    per := jsonb_set(per, array[v_to::text], to_jsonb(coalesce((per->>v_to::text)::int, 0) + 1));
    if v_to is distinct from r.assigned_to then
      moved := moved + 1;
      if not dry then
        perform set_config('closeros.skip_distribution', 'on', true);
        update public.leads set assigned_to = v_to, assigned_at = now() where id = r.id;
      end if;
    end if;
  end loop;
  perform set_config('closeros.skip_distribution', 'off', true);
  if not dry then
    insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
    values (b.org_id, auth.uid(), 'batch.assigned', 'batch', p_batch, p || jsonb_build_object('moved', moved, 'kept', kept));
  end if;
  return jsonb_build_object('moved', moved, 'kept', kept, 'tagged', tagged, 'per_person', per,
    'attendees', i + kept, 'non_attendees', j);
end $$;

-- Delete a webinar: the leads stay (only their membership in this webinar goes).
create or replace function public.delete_batch(p_batch uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.batches;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null or not public.is_org_manager(b.org_id) then raise exception 'Only managers can delete webinars'; end if;
  delete from public.batches where id = p_batch;
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
  values (b.org_id, auth.uid(), 'batch.deleted', 'batch', p_batch, jsonb_build_object('name', b.name, 'webinar_at', b.webinar_at));
end $$;

-- Webinar card numbers: registered · assigned · called · attended · hot · unassigned.
create or replace function public.batch_cards(p_org uuid) returns table (
  id uuid, name text, kind text, webinar_at timestamptz, auto_created boolean, zoom_uploaded boolean,
  registered int, assigned int, unassigned int, called int, attended int, hot int, repeats int)
language sql stable security definer set search_path = '' as $$
  select b.id, b.name, b.kind, b.webinar_at, b.auto_created, b.zoom_uploaded_at is not null,
    count(l.id)::int,
    count(l.id) filter (where l.assigned_to is not null)::int,
    count(l.id) filter (where l.assigned_to is null)::int,
    count(l.id) filter (where coalesce(l.dial_count, 0) > 0)::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) > 0 or coalesce(bl.attended, false))::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) >= b.hot_minutes or coalesce(bl.warmth, 0) >= 70)::int,
    count(l.id) filter (where bl.is_repeat)::int
  from public.batches b
  left join public.batch_leads bl on bl.batch_id = b.id
  left join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  where b.org_id = p_org and not b.is_archived and public.is_org_manager(p_org)
  group by b.id
  order by b.webinar_at desc
$$;

revoke execute on function public.webinar_parse(text, text) from anon, public;
grant execute on function public.webinar_parse(text, text) to authenticated;
revoke execute on function public.batch_for_text(uuid, text, uuid) from anon, public, authenticated;
revoke execute on function public.member_by_name(uuid, text) from anon, public, authenticated;
revoke execute on function public.assign_batch_leads(uuid, jsonb) from anon, public;
grant execute on function public.assign_batch_leads(uuid, jsonb) to authenticated;
revoke execute on function public.delete_batch(uuid) from anon, public;
grant execute on function public.delete_batch(uuid) to authenticated;
revoke execute on function public.batch_cards(uuid) from anon, public;
grant execute on function public.batch_cards(uuid) to authenticated;

-- Real headings from what the sheets / webhooks already sent (e.g. "Date & Time" instead of "Date Time").
insert into public.lead_fields (org_id, key, label, seen_count)
select distinct on (org_id, key) org_id, key, label, n from (
  select e.org_id, public.lead_key(k) key, left(regexp_replace(trim(k), '\s+', ' ', 'g'), 80) label, count(*)::int n
  from public.lead_source_events e, jsonb_each(e.payload) j(k, v)
  where jsonb_typeof(e.payload) = 'object' and jsonb_typeof(v) not in ('object', 'array') and public.lead_key(k) <> ''
    and k not in ('is_test', 'google_key', 'api_version')
  group by 1, 2, 3) x
order by org_id, key, n desc
on conflict (org_id, key) do update set
  label = case when public.lead_fields.label = initcap(replace(public.lead_fields.key, '_', ' ')) then excluded.label else public.lead_fields.label end;

-- Sign-up time for sheet leads that came in before: their "Date & Time" column.
update public.leads l set signup_at = public.parse_any_date(coalesce(l.custom->>'date_time', l.custom->>'timestamp'), coalesce(o.timezone, 'Asia/Kolkata'))
from public.organizations o
where o.id = l.org_id and l.signup_at is null and (l.custom ? 'date_time' or l.custom ? 'timestamp');

-- Every lead has a sign-up time (leads without a sheet date: when they were added) → one simple "newest sign-ups first".
update public.leads set signup_at = created_at where signup_at is null;
alter table public.leads alter column signup_at set default now();
