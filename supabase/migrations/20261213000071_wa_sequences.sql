-- WhatsApp sequences: a set of messages sent to a lead over days (Day 0, Day 2, Day 5… or timed around an event).
-- Sending stays assisted (one tap per lead in the app's WhatsApp queue); the server only plans what is due when.
-- Company sequences (owner_id null, managers) + personal ones (owner_id = the rep). Up to 50 messages, Day 365.

create table if not exists public.wa_sequences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade,          -- null = company sequence
  name text not null,
  start_outcomes uuid[] not null default '{}',                        -- start automatically when one of these outcomes is saved
  is_archived boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wa_sequences_org on public.wa_sequences (org_id) where not is_archived;

create table if not exists public.wa_sequence_messages (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.wa_sequences(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  position int not null,
  anchor text not null default 'start' check (anchor in ('start', 'event')),
  day_offset int not null default 0 check (day_offset between 0 and 365),   -- anchor start: days after the lead joined
  send_time time not null default '10:00',                                  -- anchor start: time of day (company time zone)
  minutes_before int,                                                       -- anchor event: minutes before the event (negative = after)
  body text not null default '',
  media_path text, media_type text, media_name text,
  unique (sequence_id, position)
);

create table if not exists public.wa_sequence_leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  sequence_id uuid not null references public.wa_sequences(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,        -- who sends the messages
  batch_id uuid references public.batches(id) on delete set null,          -- event the "before the event" messages follow
  started_at timestamptz not null default now(),
  started_by uuid default auth.uid(),
  how text not null default 'manual',                                       -- manual | event | outcome
  status text not null default 'active' check (status in ('active', 'paused', 'stopped', 'done')),
  stop_reason text,
  next_pos int,
  next_due_at timestamptz,
  sent_count int not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists wa_sequence_leads_one on public.wa_sequence_leads (sequence_id, lead_id) where status in ('active', 'paused');
create index if not exists wa_sequence_leads_due on public.wa_sequence_leads (org_id, user_id, next_due_at) where status = 'active';
create index if not exists wa_sequence_leads_lead on public.wa_sequence_leads (lead_id);

create table if not exists public.wa_sequence_sends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null references public.wa_sequence_leads(id) on delete cascade,
  sequence_id uuid not null references public.wa_sequences(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  position int not null,
  due_at timestamptz not null,
  done_at timestamptz not null default now(),
  status text not null check (status in ('sent', 'skipped')),
  wa_message_id uuid references public.wa_messages(id) on delete set null
);
create index if not exists wa_sequence_sends_org on public.wa_sequence_sends (org_id, due_at);

alter table public.wa_sequences enable row level security;
alter table public.wa_sequence_messages enable row level security;
alter table public.wa_sequence_leads enable row level security;
alter table public.wa_sequence_sends enable row level security;
-- Reads only; every change goes through the functions below.
drop policy if exists seq_read on public.wa_sequences;
create policy seq_read on public.wa_sequences for select to authenticated using (
  public.is_org_member(org_id) and (owner_id is null or owner_id = auth.uid() or public.can_see_user(org_id, owner_id)));
drop policy if exists seq_msg_read on public.wa_sequence_messages;
create policy seq_msg_read on public.wa_sequence_messages for select to authenticated using (
  exists (select 1 from public.wa_sequences s where s.id = sequence_id));
drop policy if exists seq_leads_read on public.wa_sequence_leads;
create policy seq_leads_read on public.wa_sequence_leads for select to authenticated using (
  user_id = auth.uid() or public.can_see_user(org_id, user_id) or public.lead_visible(lead_id));
drop policy if exists seq_sends_read on public.wa_sequence_sends;
create policy seq_sends_read on public.wa_sequence_sends for select to authenticated using (
  user_id = auth.uid() or public.can_see_user(org_id, user_id));

-- ── Planning ──
create or replace function public.seq_is_work_day(p_org uuid, p_user uuid, p_day date)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.working_days(p_org, p_user, p_day, p_day) = 1
$$;

-- When one message of an enrollment is due (null = can't be planned, e.g. "before the event" without an event).
create or replace function public.seq_message_due(p_enroll uuid, p_msg uuid)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
declare e record; m record; v_tz text; v_day date; v_at timestamptz; v_event timestamptz; i int := 0;
begin
  select * into e from public.wa_sequence_leads where id = p_enroll;
  select * into m from public.wa_sequence_messages where id = p_msg;
  if e is null or m is null then return null; end if;
  if m.anchor = 'event' then
    select webinar_at into v_event from public.batches where id = e.batch_id;
    if v_event is null then return null; end if;
    return v_event - make_interval(mins => coalesce(m.minutes_before, 0));
  end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = e.org_id;
  v_day := (e.started_at at time zone v_tz)::date + m.day_offset;
  -- Later days never land on a holiday / day off: they move to the next working day.
  if m.day_offset > 0 then
    while not public.seq_is_work_day(e.org_id, e.user_id, v_day) and i < 14 loop v_day := v_day + 1; i := i + 1; end loop;
  end if;
  v_at := (v_day + m.send_time) at time zone v_tz;
  if v_at < e.started_at then v_at := e.started_at; end if;   -- Day 0 after its time: due straight away
  return v_at;
end $$;

-- Moves an enrollment to its next message at or after p_from (skipping messages that can't be planned or whose
-- event moment is long gone); marks it done when nothing is left.
create or replace function public.seq_advance(p_enroll uuid, p_from int)
returns void language plpgsql security definer set search_path = '' as $$
declare e record; m record; v_due timestamptz;
begin
  select * into e from public.wa_sequence_leads where id = p_enroll;
  if e is null then return; end if;
  for m in select * from public.wa_sequence_messages where sequence_id = e.sequence_id and position >= p_from order by position loop
    v_due := public.seq_message_due(p_enroll, m.id);
    if v_due is null then continue; end if;
    if m.anchor = 'event' and v_due < now() - interval '12 hours' then continue; end if;
    update public.wa_sequence_leads set next_pos = m.position, next_due_at = v_due, updated_at = now() where id = p_enroll;
    return;
  end loop;
  update public.wa_sequence_leads set next_pos = null, next_due_at = null,
    status = case when status in ('active', 'paused') then 'done' else status end, updated_at = now() where id = p_enroll;
end $$;

-- ── Sequences (create / edit / archive / list) ──
create or replace function public.save_sequence(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_company boolean := coalesce((p->>'company')::boolean, false);
  s record; x jsonb; i int := 0; v_n int; e record;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_n := jsonb_array_length(coalesce(p->'messages', '[]'));
  if v_n = 0 then raise exception 'Add at least one message'; end if;
  if v_n > 50 then raise exception 'A sequence can have up to 50 messages'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Give the sequence a name'; end if;
  if v_id is not null then
    select * into s from public.wa_sequences where id = v_id and org_id = p_org;
    if s is null then raise exception 'Sequence not found'; end if;
    if s.owner_id is null and not public.is_org_manager(p_org) then raise exception 'Only managers can change company sequences'; end if;
    if s.owner_id is not null and s.owner_id <> auth.uid() then raise exception 'This is someone else''s sequence'; end if;
    update public.wa_sequences set name = trim(p->>'name'),
      start_outcomes = coalesce(array(select jsonb_array_elements_text(p->'start_outcomes')::uuid), '{}'), updated_at = now()
    where id = v_id;
    delete from public.wa_sequence_messages where sequence_id = v_id;
  else
    if v_company and not public.is_org_manager(p_org) then raise exception 'Only managers can make company sequences'; end if;
    insert into public.wa_sequences (org_id, owner_id, name, start_outcomes)
    values (p_org, case when v_company then null else auth.uid() end, trim(p->>'name'),
      coalesce(array(select jsonb_array_elements_text(p->'start_outcomes')::uuid), '{}'))
    returning id into v_id;
  end if;
  for x in select * from jsonb_array_elements(p->'messages') loop
    i := i + 1;
    if coalesce(trim(x->>'body'), '') = '' and coalesce(x->>'media_path', '') = '' then raise exception 'Message % is empty', i; end if;
    insert into public.wa_sequence_messages (sequence_id, org_id, position, anchor, day_offset, send_time, minutes_before, body, media_path, media_type, media_name)
    values (v_id, p_org, i, coalesce(nullif(x->>'anchor', ''), 'start'), least(greatest(coalesce((x->>'day_offset')::int, 0), 0), 365),
      coalesce(nullif(x->>'send_time', '')::time, '10:00'), (x->>'minutes_before')::int, coalesce(x->>'body', ''),
      nullif(x->>'media_path', ''), nullif(x->>'media_type', ''), nullif(x->>'media_name', ''));
  end loop;
  -- Leads already on it follow the new plan from where they are.
  for e in select id, next_pos from public.wa_sequence_leads where sequence_id = v_id and status in ('active', 'paused') loop
    perform public.seq_advance(e.id, coalesce(e.next_pos, 1));
  end loop;
  return v_id;
end $$;

create or replace function public.archive_sequence(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  select * into s from public.wa_sequences where id = p_id;
  if s is null or not public.is_org_member(s.org_id) then raise exception 'Not allowed'; end if;
  if (s.owner_id is null and not public.is_org_manager(s.org_id)) or (s.owner_id is not null and s.owner_id <> auth.uid()) then
    raise exception 'Not allowed'; end if;
  update public.wa_sequences set is_archived = true, updated_at = now() where id = p_id;
  update public.wa_sequence_leads set status = 'stopped', stop_reason = 'Sequence deleted', next_due_at = null, updated_at = now()
  where sequence_id = p_id and status in ('active', 'paused');
end $$;

-- Company + my sequences (managers also see their team's personal ones) with messages and lead counts.
create or replace function public.sequences(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'owner_id', s.owner_id, 'company', s.owner_id is null, 'mine', s.owner_id = auth.uid(),
    'owner_name', (select full_name from public.profiles p where p.id = s.owner_id),
    'start_outcomes', to_jsonb(s.start_outcomes), 'updated_at', s.updated_at,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'position', m.position, 'anchor', m.anchor, 'day_offset', m.day_offset,
        'send_time', to_char(m.send_time, 'HH24:MI'), 'minutes_before', m.minutes_before, 'body', m.body,
        'media_path', m.media_path, 'media_type', m.media_type, 'media_name', m.media_name) order by m.position)
      from public.wa_sequence_messages m where m.sequence_id = s.id), '[]'),
    'active_mine', (select count(*) from public.wa_sequence_leads e where e.sequence_id = s.id and e.status = 'active' and e.user_id = auth.uid()),
    'active_all', (select count(*) from public.wa_sequence_leads e where e.sequence_id = s.id and e.status = 'active'),
    'done_all', (select count(*) from public.wa_sequence_leads e where e.sequence_id = s.id and e.status = 'done')
  ) order by s.owner_id is not null, s.name), '[]')
  from public.wa_sequences s
  where s.org_id = p_org and not s.is_archived and public.is_org_member(p_org)
    and (s.owner_id is null or s.owner_id = auth.uid() or public.can_see_user(p_org, s.owner_id))
$$;

-- ── Leads on a sequence ──
-- Internal: puts one lead on a sequence (skips DNC and leads already on it). Returns the enrollment id or null.
create or replace function public.seq_enroll(p_seq uuid, p_lead uuid, p_user uuid, p_batch uuid, p_how text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s record; l record; v_batch uuid := p_batch; v_id uuid;
begin
  select * into s from public.wa_sequences where id = p_seq and not is_archived;
  select id, org_id, do_not_call, phone into l from public.leads where id = p_lead;
  if s is null or l is null or l.org_id <> s.org_id or coalesce(l.do_not_call, false) or coalesce(l.phone, '') = '' then return null; end if;
  if exists (select 1 from public.wa_sequence_leads where sequence_id = p_seq and lead_id = p_lead and status in ('active', 'paused')) then return null; end if;
  if v_batch is null and exists (select 1 from public.wa_sequence_messages where sequence_id = p_seq and anchor = 'event') then
    select bl.batch_id into v_batch from public.batch_leads bl join public.batches b on b.id = bl.batch_id
    where bl.lead_id = p_lead and not coalesce(b.is_archived, false)
    order by (b.webinar_at >= now() - interval '1 day') desc, abs(extract(epoch from b.webinar_at - now())) limit 1;
  end if;
  insert into public.wa_sequence_leads (org_id, sequence_id, lead_id, user_id, batch_id, how)
  values (s.org_id, p_seq, p_lead, p_user, v_batch, p_how) returning id into v_id;
  perform public.seq_advance(v_id, 1);
  return v_id;
end $$;

-- Start a sequence for leads (from the lead page, the Leads tab, an event, the outcome screen).
-- Messages are sent by the lead's own rep when a manager starts it; otherwise by the person starting it.
create or replace function public.start_sequence(p_seq uuid, p_leads uuid[], p_batch uuid default null, p_how text default 'manual')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s record; v_lead uuid; v_user uuid; v_mgr boolean; v_ok int := 0; v_skip int := 0; a uuid;
begin
  select * into s from public.wa_sequences where id = p_seq and not is_archived;
  if s is null or not public.is_org_member(s.org_id) then raise exception 'Sequence not found'; end if;
  if s.owner_id is not null and s.owner_id <> auth.uid() then raise exception 'This is someone else''s sequence'; end if;
  v_mgr := public.is_org_manager(s.org_id);
  foreach v_lead in array coalesce(p_leads, '{}') loop
    if not public.lead_visible(v_lead) then v_skip := v_skip + 1; continue; end if;
    v_user := auth.uid();
    if v_mgr and s.owner_id is null then
      select assigned_to into a from public.leads where id = v_lead;
      if a is not null and exists (select 1 from public.org_members m where m.org_id = s.org_id and m.user_id = a and m.status = 'active') then v_user := a; end if;
    end if;
    if public.seq_enroll(p_seq, v_lead, v_user, p_batch, coalesce(nullif(p_how, ''), 'manual')) is null then v_skip := v_skip + 1; else v_ok := v_ok + 1; end if;
  end loop;
  return jsonb_build_object('started', v_ok, 'skipped', v_skip);
end $$;

-- Pause / resume / stop one lead's sequence.
create or replace function public.set_sequence_lead(p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare e record;
begin
  select * into e from public.wa_sequence_leads where id = p_id;
  if e is null or not (e.user_id = auth.uid() or public.can_see_user(e.org_id, e.user_id) or public.lead_visible(e.lead_id)) then raise exception 'Not allowed'; end if;
  if p_action = 'pause' and e.status = 'active' then
    update public.wa_sequence_leads set status = 'paused', updated_at = now() where id = p_id;
  elsif p_action = 'resume' and e.status = 'paused' then
    update public.wa_sequence_leads set status = 'active', updated_at = now() where id = p_id;
    perform public.seq_advance(p_id, coalesce(e.next_pos, 1));
  elsif p_action = 'stop' and e.status in ('active', 'paused') then
    update public.wa_sequence_leads set status = 'stopped', stop_reason = 'Stopped by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'a team member'),
      next_due_at = null, updated_at = now() where id = p_id;
  end if;
end $$;

-- The lead page: this lead's sequences.
create or replace function public.lead_sequences(p_lead uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id, 'name', s.name, 'status', e.status,
    'stop_reason', e.stop_reason, 'next_pos', e.next_pos, 'next_due_at', e.next_due_at, 'sent_count', e.sent_count,
    'total', (select count(*) from public.wa_sequence_messages m where m.sequence_id = s.id),
    'user_id', e.user_id, 'started_at', e.started_at) order by (e.status in ('active', 'paused')) desc, e.started_at desc), '[]')
  from public.wa_sequence_leads e join public.wa_sequences s on s.id = e.sequence_id
  where e.lead_id = p_lead and public.lead_visible(p_lead) and e.started_at > now() - interval '180 days'
$$;

-- My messages due now (and how many more come later today), each with its lead and message.
create or replace function public.my_sequence_due(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_end timestamptz; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_end := ((now() at time zone v_tz)::date + 1)::timestamp at time zone v_tz;
  select jsonb_build_object(
    'due', coalesce((select jsonb_agg(r order by r->>'due_at') from (
      select jsonb_build_object('id', e.id, 'sequence_id', s.id, 'sequence', s.name, 'position', m.position,
        'total', (select count(*) from public.wa_sequence_messages x where x.sequence_id = s.id),
        'due_at', e.next_due_at, 'body', m.body, 'media_path', m.media_path, 'media_type', m.media_type, 'media_name', m.media_name,
        'lead', to_jsonb(l) || jsonb_build_object('batch_leads', coalesce((
          select jsonb_agg(jsonb_build_object('batch_id', b.id, 'batch', jsonb_build_object('name', b.name, 'webinar_at', b.webinar_at)))
          from public.batches b where b.id = e.batch_id), '[]'))) r
      from public.wa_sequence_leads e
      join public.wa_sequences s on s.id = e.sequence_id
      join public.wa_sequence_messages m on m.sequence_id = e.sequence_id and m.position = e.next_pos
      join public.leads l on l.id = e.lead_id
      where e.org_id = p_org and e.user_id = auth.uid() and e.status = 'active' and e.next_due_at <= now()
      limit 500) q), '[]'),
    'later_today', (select count(*) from public.wa_sequence_leads e where e.org_id = p_org and e.user_id = auth.uid()
      and e.status = 'active' and e.next_due_at > now() and e.next_due_at < v_end)
  ) into res;
  return res;
end $$;

-- Back from WhatsApp: sent (counted as a WhatsApp message) or skipped → the lead moves to the next message.
create or replace function public.sequence_mark(p_id uuid, p_sent boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare e record; s record; v_wa uuid; v_phone text;
begin
  select * into e from public.wa_sequence_leads where id = p_id;
  if e is null or e.user_id <> auth.uid() then raise exception 'Not allowed'; end if;
  if e.status <> 'active' or e.next_pos is null then return; end if;
  select * into s from public.wa_sequences where id = e.sequence_id;
  if p_sent then
    select phone into v_phone from public.leads where id = e.lead_id;
    insert into public.wa_messages (org_id, lead_id, user_id, phone, template_name, source)
    values (e.org_id, e.lead_id, auth.uid(), coalesce(v_phone, ''), s.name || ' · message ' || e.next_pos, 'sequence') returning id into v_wa;
  end if;
  insert into public.wa_sequence_sends (org_id, enrollment_id, sequence_id, lead_id, user_id, position, due_at, status, wa_message_id)
  values (e.org_id, e.id, e.sequence_id, e.lead_id, e.user_id, e.next_pos, coalesce(e.next_due_at, now()), case when p_sent then 'sent' else 'skipped' end, v_wa);
  update public.wa_sequence_leads set sent_count = sent_count + case when p_sent then 1 else 0 end, updated_at = now() where id = p_id;
  perform public.seq_advance(p_id, e.next_pos + 1);
end $$;

-- ── Automatic start / stop ──
-- Saving an outcome: stops sequences when the lead is won / lost (not those this outcome itself starts), then starts
-- the sequences whose rule is this outcome (company rules + the caller's own), sent by the caller.

create or replace function public.t_seq_on_call_outcome()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cat text; s record;
begin
  if new.outcome_id is null or new.lead_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.outcome_id is not distinct from old.outcome_id then return new; end if;
  select category::text into v_cat from public.call_outcomes where id = new.outcome_id;
  if v_cat in ('won', 'lost') then
    update public.wa_sequence_leads e set status = 'stopped', next_due_at = null, updated_at = now(),
      stop_reason = case when v_cat = 'won' then 'Lead bought' else 'Lead not interested' end
    where e.lead_id = new.lead_id and e.status in ('active', 'paused')
      and not exists (select 1 from public.wa_sequences s where s.id = e.sequence_id and new.outcome_id = any(s.start_outcomes));
  end if;
  for s in select id from public.wa_sequences
    where org_id = new.org_id and not is_archived and new.outcome_id = any(start_outcomes)
      and (owner_id is null or owner_id = new.user_id) loop
    perform public.seq_enroll(s.id, new.lead_id, new.user_id, new.batch_id, 'outcome');
  end loop;
  return new;
end $$;
drop trigger if exists t_seq_on_call_outcome on public.calls;
create trigger t_seq_on_call_outcome after insert or update of outcome_id on public.calls
  for each row execute function public.t_seq_on_call_outcome();

-- Do not call → every sequence of the lead stops.
create or replace function public.t_seq_on_dnc()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.do_not_call, false) and not coalesce(old.do_not_call, false) then
    update public.wa_sequence_leads set status = 'stopped', stop_reason = 'Marked Do not call', next_due_at = null, updated_at = now()
    where lead_id = new.id and status in ('active', 'paused');
  end if;
  return new;
end $$;
drop trigger if exists t_seq_on_dnc on public.leads;
create trigger t_seq_on_dnc after update of do_not_call on public.leads for each row execute function public.t_seq_on_dnc();

-- ── Report (dashboard Reports → WhatsApp sequences) ──
-- On time = sent on the day it was due (company time zone) or earlier; late = a later day; not sent = skipped
-- or still waiting past its day. Converted = bought after joining the sequence.
create or replace function public.sequence_report(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_from timestamptz; v_to timestamptz; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  v_from := p_from::timestamp at time zone v_tz; v_to := (p_to + 1)::timestamp at time zone v_tz;
  with d as (
    select x.user_id, x.sequence_id,
      count(*) filter (where x.status = 'sent' and (x.done_at at time zone v_tz)::date <= (x.due_at at time zone v_tz)::date) on_time,
      count(*) filter (where x.status = 'sent' and (x.done_at at time zone v_tz)::date > (x.due_at at time zone v_tz)::date) late,
      count(*) filter (where x.status = 'skipped') skipped
    from public.wa_sequence_sends x
    where x.org_id = p_org and x.due_at >= v_from and x.due_at < v_to and x.user_id = any(v_users)
    group by 1, 2
  ), w as (
    select e.user_id, e.sequence_id, count(*) waiting
    from public.wa_sequence_leads e
    where e.org_id = p_org and e.status = 'active' and e.next_due_at >= v_from and e.next_due_at < least(v_to, now())
      and (e.next_due_at at time zone v_tz)::date < (now() at time zone v_tz)::date and e.user_id = any(v_users)
    group by 1, 2
  ), j as (
    select e.user_id, e.sequence_id, count(*) joined,
      count(*) filter (where l.won_at is not null and l.won_at >= e.started_at) converted
    from public.wa_sequence_leads e join public.leads l on l.id = e.lead_id
    where e.org_id = p_org and e.started_at >= v_from and e.started_at < v_to and e.user_id = any(v_users)
    group by 1, 2
  ), k as (
    select coalesce(d.user_id, w.user_id, j.user_id) user_id, coalesce(d.sequence_id, w.sequence_id, j.sequence_id) sequence_id,
      coalesce(d.on_time, 0) on_time, coalesce(d.late, 0) late, coalesce(d.skipped, 0) skipped, coalesce(w.waiting, 0) waiting,
      coalesce(j.joined, 0) joined, coalesce(j.converted, 0) converted
    from d full join w on w.user_id = d.user_id and w.sequence_id = d.sequence_id
      full join j on j.user_id = coalesce(d.user_id, w.user_id) and j.sequence_id = coalesce(d.sequence_id, w.sequence_id)
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object('on_time', coalesce(sum(on_time), 0), 'late', coalesce(sum(late), 0), 'skipped', coalesce(sum(skipped), 0),
      'waiting', coalesce(sum(waiting), 0), 'joined', coalesce(sum(joined), 0), 'converted', coalesce(sum(converted), 0)) from k),
    'people', coalesce((select jsonb_agg(r order by (r->>'on_time')::int + (r->>'late')::int desc) from (
      select jsonb_build_object('user_id', k.user_id, 'name', (select full_name from public.profiles p where p.id = k.user_id),
        'on_time', sum(on_time), 'late', sum(late), 'skipped', sum(skipped), 'waiting', sum(waiting), 'joined', sum(joined), 'converted', sum(converted)) r
      from k group by k.user_id) q), '[]'),
    'sequences', coalesce((select jsonb_agg(r order by r->>'name') from (
      select jsonb_build_object('sequence_id', k.sequence_id, 'name', (select name from public.wa_sequences s where s.id = k.sequence_id),
        'on_time', sum(on_time), 'late', sum(late), 'skipped', sum(skipped), 'waiting', sum(waiting), 'joined', sum(joined), 'converted', sum(converted)) r
      from k group by k.sequence_id) q), '[]')
  ) into res;
  return res;
end $$;

revoke execute on function public.seq_is_work_day(uuid, uuid, date), public.seq_message_due(uuid, uuid), public.seq_advance(uuid, int),
  public.seq_enroll(uuid, uuid, uuid, uuid, text), public.t_seq_on_call_outcome(), public.t_seq_on_dnc() from public, anon, authenticated;
revoke execute on function public.save_sequence(uuid, jsonb), public.archive_sequence(uuid), public.sequences(uuid),
  public.start_sequence(uuid, uuid[], uuid, text), public.set_sequence_lead(uuid, text), public.lead_sequences(uuid),
  public.my_sequence_due(uuid), public.sequence_mark(uuid, boolean), public.sequence_report(uuid, date, date) from public, anon;
grant execute on function public.save_sequence(uuid, jsonb), public.archive_sequence(uuid), public.sequences(uuid),
  public.start_sequence(uuid, uuid[], uuid, text), public.set_sequence_lead(uuid, text), public.lead_sequences(uuid),
  public.my_sequence_due(uuid), public.sequence_mark(uuid, boolean), public.sequence_report(uuid, date, date) to authenticated;

-- wa_messages.source gains 'sequence' (no check constraint on it — just documenting).
comment on column public.wa_messages.source is 'single | queue | popup | sequence';
