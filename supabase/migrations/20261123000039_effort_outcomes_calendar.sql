-- Round 9 (part 1): per-lead effort stats, WhatsApp sends, better outcomes, working calendar.

-- ── WhatsApp messages sent from the app (assisted queue / single sends) ──
create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id),
  phone text not null,
  template_id uuid,
  template_name text,
  source text not null default 'single',          -- single | queue | popup
  sent_at timestamptz not null default now(),
  undone_at timestamptz
);
create index if not exists wa_messages_lead on public.wa_messages (lead_id) where undone_at is null;
create index if not exists wa_messages_user_day on public.wa_messages (org_id, user_id, sent_at desc);
alter table public.wa_messages enable row level security;
drop policy if exists wa_read on public.wa_messages;
create policy wa_read on public.wa_messages for select to authenticated
  using (user_id = auth.uid() or public.can_see_user(org_id, user_id));
drop policy if exists wa_write on public.wa_messages;
create policy wa_write on public.wa_messages for insert to authenticated
  with check (user_id = auth.uid() and public.is_org_member(org_id));
drop policy if exists wa_undo on public.wa_messages;
create policy wa_undo on public.wa_messages for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Effort stats kept on each lead (updated by triggers) ──
alter table public.leads
  add column if not exists total_talk_sec int not null default 0,
  add column if not exists dial_count int not null default 0,
  add column if not exists pickup_count int not null default 0,
  add column if not exists wa_count int not null default 0,
  add column if not exists first_dialled_at timestamptz,
  add column if not exists first_talk_dial int,
  add column if not exists last_call_status text,       -- talked | not_picked | missed
  add column if not exists won_at timestamptz,
  add column if not exists score int not null default 0; -- 0–100 "close to converting"
create index if not exists leads_org_score on public.leads (org_id, score desc) where deleted_at is null;
create index if not exists leads_org_assigned_dials on public.leads (org_id, assigned_to, dial_count) where deleted_at is null;

create or replace function public.refresh_lead_stats(p_lead uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s record; v_last record; v_cat public.outcome_category; v_watch int; v_score numeric := 0; v_dnc boolean; v_lc timestamptz;
begin
  if p_lead is null then return; end if;
  select coalesce(sum(c.duration_sec), 0) talk,
         count(*) filter (where c.direction = 'outgoing') dials,
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, o.category)) picks,
         min(c.started_at) filter (where c.direction = 'outgoing') first_dial,
         min(c.started_at) filter (where o.category = 'won') won
    into s
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id where c.lead_id = p_lead;

  select c.direction, c.duration_sec, o.category into v_last
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.lead_id = p_lead order by c.started_at desc limit 1;

  select o.category, l.do_not_call, l.last_connected_at into v_cat, v_dnc, v_lc
  from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id where l.id = p_lead;
  select max(watch_minutes) into v_watch from public.batch_leads where lead_id = p_lead;

  -- Close-to-converting score (open leads only).
  if not coalesce(v_dnc, false) and coalesce(v_cat::text, '') not in ('won', 'lost', 'invalid') then
    v_score := least(s.picks, 3) * 12
             + least(s.talk / 60.0 / 30.0, 1) * 24
             + case v_cat when 'positive' then 20 when 'connected' then 8 else 0 end
             + case when coalesce(v_watch, 0) >= 60 then 15 when coalesce(v_watch, 0) > 0 then 6 else 0 end
             + case when v_lc > now() - interval '3 days' then 5 else 0 end;
  end if;

  update public.leads l set
    total_talk_sec = s.talk, dial_count = s.dials, pickup_count = s.picks,
    first_dialled_at = s.first_dial, won_at = s.won,
    first_talk_dial = (select n from (
        select row_number() over (order by c.started_at) n, public.is_real_pickup(c.direction, c.duration_sec, o.category) p
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = p_lead and c.direction = 'outgoing') x where p order by n limit 1),
    last_call_status = case
        when v_last.direction is null then null
        when v_last.direction in ('missed', 'rejected') then 'missed'
        when v_last.direction = 'incoming' then case when coalesce(v_last.duration_sec, 0) > 0 then 'talked' else 'missed' end
        when public.is_real_pickup(v_last.direction, v_last.duration_sec, v_last.category) then 'talked'
        else 'not_picked' end,
    wa_count = (select count(*) from public.wa_messages w where w.lead_id = p_lead and w.undone_at is null),
    score = round(v_score)::int
  where l.id = p_lead;
end $$;

create or replace function public.t_calls_lead_stats() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then perform public.refresh_lead_stats(old.lead_id); return old; end if;
  perform public.refresh_lead_stats(new.lead_id);
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then perform public.refresh_lead_stats(old.lead_id); end if;
  return new;
end $$;
drop trigger if exists t_calls_lead_stats on public.calls;
create trigger t_calls_lead_stats after insert or delete or update of lead_id, duration_sec, outcome_id, direction on public.calls
  for each row execute function public.t_calls_lead_stats();

create or replace function public.t_wa_lead_stats() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.leads set wa_count = (select count(*) from public.wa_messages w where w.lead_id = new.lead_id and w.undone_at is null)
  where id = new.lead_id;
  return new;
end $$;
drop trigger if exists t_wa_lead_stats on public.wa_messages;
create trigger t_wa_lead_stats after insert or update of undone_at on public.wa_messages
  for each row when (new.lead_id is not null) execute function public.t_wa_lead_stats();

-- Messages I sent today (Home → Interactions → WhatsApp list).
create or replace function public.my_wa_today(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'lead_id', w.lead_id, 'name', l.name, 'phone', w.phone,
           'template_name', w.template_name, 'sent_at', w.sent_at) order by w.sent_at desc), '[]'::jsonb)
  from public.wa_messages w left join public.leads l on l.id = w.lead_id
  join public.organizations o on o.id = w.org_id
  where w.org_id = p_org and w.user_id = auth.uid() and w.undone_at is null
    and w.sent_at >= (date_trunc('day', now() at time zone o.timezone) at time zone o.timezone)
$$;

-- Which of these lead ids already got this message today (the queue skips them).
create or replace function public.wa_sent_today(p_org uuid, p_template uuid, p_leads uuid[])
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct w.lead_id), '{}') from public.wa_messages w join public.organizations o on o.id = w.org_id
  where w.org_id = p_org and w.template_id = p_template and w.lead_id = any(p_leads) and w.undone_at is null
    and w.sent_at >= (date_trunc('day', now() at time zone o.timezone) at time zone o.timezone)
    and public.is_org_member(p_org)
$$;

create or replace function public.lead_visible_or_own_call(p_call uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.calls c where c.id = p_call and (c.user_id = auth.uid() or public.can_see_user(c.org_id, c.user_id)))
$$;

-- Which calls have a playable recording.
create or replace function public.calls_with_recording(p_ids uuid[])
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}') from public.calls c
  where c.id = any(p_ids) and c.recording_path is not null and c.recording_status::text not in ('expired', 'missing')
    and public.lead_visible_or_own_call(c.id)
$$;

-- ── Outcomes: suggested next step + the better starting list ──
alter table public.call_outcomes add column if not exists next_default text;  -- 30m 1h 2h 3h today tomorrow 2d 30d pick none

create or replace function public.apply_outcome_set_v2(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  with v(code, label, category, form, purpose, pos, nxt) as (values
    -- Sales · didn't connect
    ('no_answer',        'No answer',                          'not_connected', null,       'sales', 1,  '2h'),
    ('busy',             'Busy / cut the call',                'not_connected', null,       'sales', 2,  '1h'),
    ('not_reachable',    'Switched off / not reachable',       'not_connected', null,       'sales', 3,  'tomorrow'),
    ('not_in_service',   'Number not in service',              'invalid',       null,       'sales', 4,  'none'),
    -- Sales · connected, no real talk
    ('call_back',        'Asked to call back later',           'connected',     null,       'sales', 10, 'pick'),
    ('someone_else',     'Someone else picked up',             'connected',     null,       'sales', 11, '2h'),
    ('language',         'Language barrier',                   'connected',     null,       'sales', 12, 'none'),
    -- Sales · real conversation
    ('interested',       'Interested — needs more info',       'positive',      'interest', 'sales', 20, 'tomorrow'),
    ('deciding',         'Interested — will decide soon',      'positive',      'interest', 'sales', 21, 'pick'),
    ('demo',             'Wants a demo / meeting',             'positive',      null,       'sales', 22, 'pick'),
    ('price',            'Price objection',                    'connected',     null,       'sales', 23, 'tomorrow'),
    ('family',           'Needs to discuss with family',       'connected',     null,       'sales', 24, 'tomorrow'),
    ('payment_link',     'Payment link sent',                  'positive',      null,       'sales', 25, '3h'),
    ('later',            'Not interested now — maybe later',   'connected',     null,       'sales', 26, '30d'),
    ('not_interested',   'Not interested',                     'lost',          null,       'sales', 27, 'none'),
    -- Sales · result
    ('sale_closed',      'Sale closed',                        'won',           'sale',     'sales', 30, 'none'),
    ('already_bought',   'Already bought',                     'lost',          null,       'sales', 31, 'none'),
    -- Sales · bad lead
    ('wrong_number',     'Wrong number',                       'invalid',       null,       'sales', 40, 'none'),
    ('not_right_person', 'Not the right person / didn''t fill the form', 'invalid', null,  'sales', 41, 'none'),
    ('do_not_call',      'Do not call',                        'invalid',       null,       'sales', 42, 'none'),
    -- Webinar reminder calls
    ('r_confirmed',      'Confirmed — will join',              'positive',      null,       'reminder', 101, 'none'),
    ('r_maybe',          'Will try / maybe',                   'connected',     null,       'reminder', 102, '3h'),
    ('r_next_batch',     'Can''t attend — wants next batch',   'connected',     null,       'reminder', 103, 'none'),
    ('r_send_link',      'Asked to send the link',             'connected',     null,       'reminder', 104, 'none'),
    ('r_not_interested', 'Not interested any more',            'lost',          null,       'reminder', 105, 'none'),
    ('r_didnt_pick',     'No answer',                          'not_connected', null,       'reminder', 110, '1h'),
    ('r_busy',           'Busy',                               'not_connected', null,       'reminder', 111, '1h'),
    ('r_switched_off',   'Switched off',                       'not_connected', null,       'reminder', 112, '2h'),
    ('r_wrong_number',   'Wrong number',                       'invalid',       null,       'reminder', 120, 'none'),
    ('r_not_registered', 'Not registered',                     'invalid',       null,       'reminder', 121, 'none')
  ), up as (
    insert into public.call_outcomes (org_id, code, label, category, form, purpose, position, next_default, is_active)
    select p_org, code, label, category::public.outcome_category, form, purpose, pos, nxt, true from v
    on conflict (org_id, code) do update set label = excluded.label, category = excluded.category, form = excluded.form,
      purpose = excluded.purpose, position = excluded.position, next_default = excluded.next_default, is_active = true
    returning code
  )
  -- Old outcomes are hidden, not deleted: past calls keep them.
  update public.call_outcomes set is_active = false where org_id = p_org and code not in (select code from v);
end $$;

do $$ declare o record; begin
  for o in select id from public.organizations loop perform public.apply_outcome_set_v2(o.id); end loop;
end $$;

-- ── Working calendar: holidays for the company, leave per person ──
create table if not exists public.org_holidays (
  org_id uuid not null references public.organizations(id) on delete cascade,
  day date not null, name text not null default 'Holiday',
  primary key (org_id, day)
);
create table if not exists public.member_leave (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  primary key (org_id, user_id, day)
);
alter table public.org_holidays enable row level security;
alter table public.member_leave enable row level security;
drop policy if exists hol_read on public.org_holidays;
create policy hol_read on public.org_holidays for select to authenticated using (public.is_org_member(org_id));
drop policy if exists hol_write on public.org_holidays;
create policy hol_write on public.org_holidays for all to authenticated using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));
drop policy if exists leave_read on public.member_leave;
create policy leave_read on public.member_leave for select to authenticated using (user_id = auth.uid() or public.can_see_user(org_id, user_id));
drop policy if exists leave_write on public.member_leave;
create policy leave_write on public.member_leave for all to authenticated using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));

-- Working days for one person between two dates (weekdays set by the company, minus holidays and leave).
create or replace function public.working_days(p_org uuid, p_user uuid, p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from generate_series(p_from, p_to, interval '1 day') d
  where extract(isodow from d)::int = any(coalesce((select array_agg(x::int) from public.organizations o, jsonb_array_elements_text(o.settings->'work_days') x where o.id = p_org), array[1,2,3,4,5,6]))
    and not exists (select 1 from public.org_holidays h where h.org_id = p_org and h.day = d::date)
    and not exists (select 1 from public.member_leave m where m.org_id = p_org and m.user_id = p_user and m.day = d::date)
$$;

-- Targets now follow each person's own working days.
create or replace function public.target_progress(p_org uuid, p_from date, p_to date, p_users uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_days int; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'Choose up to 3 months'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  v_days := public.working_days(p_org, null, p_from, p_to);

  with people as (
    select m.user_id, public.working_days(p_org, m.user_id, p_from, p_to) days
    from public.org_members m where m.org_id = p_org and m.status = 'active' and m.user_id = any(v_users)
  ), t as (
    select p.user_id, p.days,
      coalesce(r.calls, d.calls) as calls, coalesce(r.conversations, d.conversations) as conversations,
      coalesce(r.talk_minutes, d.talk_minutes) as talk_minutes, coalesce(r.sales, d.sales) as sales,
      r.id is not null as own
    from people p
    left join public.rep_targets r on r.org_id = p_org and r.user_id = p.user_id
    left join public.rep_targets d on d.org_id = p_org and d.user_id is null
  ), a as (
    select c.user_id,
      count(*) filter (where c.direction = 'outgoing') as calls,
      count(*) filter (where c.duration_sec > 0) as conversations,
      coalesce(sum(c.duration_sec), 0) / 60 as talk_minutes,
      count(*) filter (where o.category = 'won') as sales
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.user_id = any(v_users)
      and c.started_at >= (p_from::timestamp at time zone v_tz) and c.started_at < ((p_to + 1)::timestamp at time zone v_tz)
    group by c.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'own_target', t.own, 'work_days', t.days,
      'target', jsonb_build_object('calls', t.calls * t.days, 'conversations', t.conversations * t.days,
                                   'talk_minutes', t.talk_minutes * t.days, 'sales', t.sales * t.days),
      'daily', jsonb_build_object('calls', t.calls, 'conversations', t.conversations, 'talk_minutes', t.talk_minutes, 'sales', t.sales),
      'actual', jsonb_build_object('calls', coalesce(a.calls, 0), 'conversations', coalesce(a.conversations, 0),
                                   'talk_minutes', coalesce(a.talk_minutes, 0), 'sales', coalesce(a.sales, 0))
    )), '[]'::jsonb) into res
  from t left join a on a.user_id = t.user_id;
  return jsonb_build_object('work_days', v_days, 'rows', res);
end $$;

-- Backfill the stats for every existing lead.
do $$ declare l record; begin
  for l in select id from public.leads where deleted_at is null loop perform public.refresh_lead_stats(l.id); end loop;
end $$;
