-- Team member efficiency: working day (Start / End day), breaks, time in the app, time saving
-- outcomes (CRM), calls, WhatsApp; idle = gaps of 15+ min with nothing; four scores + overall.

-- Start day / break / end day, sent by the phone (id made on the phone: a retry never duplicates).
create table if not exists public.work_events (
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('day_start', 'day_end', 'break_start', 'break_end')),
  break_type text,
  at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists work_events_user_at on public.work_events (org_id, user_id, at);
alter table public.work_events enable row level security;
drop policy if exists work_events_select on public.work_events;
create policy work_events_select on public.work_events for select
  using (user_id = auth.uid() or (public.is_org_member(org_id) and public.can_see_user(org_id, user_id)));

-- Time blocks measured on the phone: app = Closer OS on screen, crm = saving an outcome / editing a
-- lead / notes, call = phone line busy (dialling + ringing + talking).
create table if not exists public.activity_segments (
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('app', 'crm', 'call', 'wa')),
  started_at timestamptz not null,
  ended_at timestamptz not null check (ended_at >= started_at),
  created_at timestamptz not null default now()
);
create index if not exists activity_segments_user_at on public.activity_segments (org_id, user_id, started_at);
-- 'wa' = time away in WhatsApp after opening it from Closer OS (measured, to tune the fixed time per message).
alter table public.activity_segments drop constraint if exists activity_segments_kind_check;
alter table public.activity_segments add constraint activity_segments_kind_check check (kind in ('app', 'crm', 'call', 'wa'));
alter table public.activity_segments enable row level security;
drop policy if exists activity_segments_select on public.activity_segments;
create policy activity_segments_select on public.activity_segments for select
  using (user_id = auth.uid() or (public.is_org_member(org_id) and public.can_see_user(org_id, user_id)));

-- How long the rep was really away in WhatsApp for a message (measured; used to tune the fixed time).
alter table public.wa_messages add column if not exists away_sec int;
-- When the outcome of a call was saved (for "outcomes filled on time").
alter table public.calls add column if not exists outcome_at timestamptz;
create or replace function public.t_call_outcome_at() returns trigger language plpgsql as $$
begin
  if new.outcome_id is not null and (tg_op = 'INSERT' or old.outcome_id is null) then
    new.outcome_at := coalesce(new.outcome_at, now());
  end if;
  return new;
end $$;
drop trigger if exists t_call_outcome_at on public.calls;
create trigger t_call_outcome_at before insert or update of outcome_id on public.calls
  for each row execute function public.t_call_outcome_at();

create or replace function public.log_work_events(p_org uuid, p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member'; end if;
  insert into public.work_events (id, org_id, user_id, kind, break_type, at)
  select (e->>'id')::uuid, p_org, auth.uid(), e->>'kind', nullif(e->>'break_type', ''), (e->>'at')::timestamptz
  from jsonb_array_elements(p) e
  where e->>'kind' in ('day_start', 'day_end', 'break_start', 'break_end')
    and (e->>'at')::timestamptz between now() - interval '30 days' and now() + interval '10 minutes'
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.upload_activity(p_org uuid, p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member'; end if;
  insert into public.activity_segments (id, org_id, user_id, kind, started_at, ended_at)
  select (e->>'id')::uuid, p_org, auth.uid(), e->>'kind', (e->>'start')::timestamptz,
         least((e->>'end')::timestamptz, (e->>'start')::timestamptz + interval '4 hours')
  from jsonb_array_elements(p) e
  where e->>'kind' in ('app', 'crm', 'call', 'wa') and (e->>'end')::timestamptz >= (e->>'start')::timestamptz
    and (e->>'start')::timestamptz > now() - interval '30 days'
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.set_wa_away(p_id uuid, p_sec int)
returns void language sql security definer set search_path = '' as $$
  update public.wa_messages set away_sec = least(greatest(p_sec, 0), 3600) where id = p_id and user_id = auth.uid();
$$;

create or replace function public.mr_sec(m tstzmultirange)
returns int language sql immutable as $$
  select coalesce(sum(extract(epoch from upper(r) - lower(r)))::int, 0) from unnest(m) r;
$$;

-- Company settings with defaults.
create or replace function public.efficiency_settings(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'shift_start', coalesce(o.settings->'efficiency'->>'shift_start', '10:00'),
    'shift_end', coalesce(o.settings->'efficiency'->>'shift_end', '19:00'),
    'break_min', coalesce((o.settings->'efficiency'->>'break_min')::int, 60),
    'idle_min', coalesce((o.settings->'efficiency'->>'idle_min')::int, 15),
    'wa_sec', coalesce((o.settings->'efficiency'->>'wa_sec')::int, 30),
    'w_time', coalesce((o.settings->'efficiency'->'weights'->>'time')::int, 30),
    'w_calling', coalesce((o.settings->'efficiency'->'weights'->>'calling')::int, 35),
    'w_conversion', coalesce((o.settings->'efficiency'->'weights'->>'conversion')::int, 10),
    'w_discipline', coalesce((o.settings->'efficiency'->'weights'->>'discipline')::int, 25),
    'tz', o.timezone,
    'wa_measured_sec', (select round(percentile_cont(0.5) within group (order by extract(epoch from a.ended_at - a.started_at)))
                        from public.activity_segments a where a.org_id = p_org and a.kind = 'wa' and a.started_at > now() - interval '30 days'
                          and a.ended_at - a.started_at between interval '3 seconds' and interval '10 minutes'),
    'wa_measured_n', (select count(*) from public.activity_segments a where a.org_id = p_org and a.kind = 'wa' and a.started_at > now() - interval '30 days'))
  from public.organizations o where o.id = p_org;
$$;

-- One person's working day split into time buckets (seconds). p_hour = an hour of that day (0–23) to
-- get only that hour's split, null for the whole day.
create or replace function public.work_day(p_org uuid, p_user uuid, p_day date, p_hour int default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s jsonb := public.efficiency_settings(p_org);
  v_tz text := s->>'tz';
  d0 timestamptz := (p_day::timestamp) at time zone v_tz;
  d1 timestamptz := ((p_day + 1)::timestamp) at time zone v_tz;
  v_start timestamptz; v_end timestamptz; v_pressed_start timestamptz; v_pressed_end timestamptz;
  w tstzmultirange; calls_r tstzmultirange; wa_r tstzmultirange; crm_r tstzmultirange; app_r tstzmultirange;
  act tstzmultirange; brk tstzmultirange; gaps tstzmultirange; idle tstzmultirange := '{}'; between tstzmultirange := '{}';
  g tstzrange; v_talk int; v_wa_n int; v_late int; env tstzmultirange;
begin
  select min(at) filter (where kind = 'day_start'), max(at) filter (where kind = 'day_end')
    into v_pressed_start, v_pressed_end
  from public.work_events where org_id = p_org and user_id = p_user and at >= d0 and at < d1;

  -- Every piece of activity of the day.
  select coalesce(range_agg(tstzrange(c.started_at, c.started_at + make_interval(secs => c.duration_sec
           + case when c.direction = 'outgoing' then case when c.duration_sec = 0 then 30 else 15 end else 0 end))), '{}')
    into calls_r
  from public.calls c where c.org_id = p_org and c.user_id = p_user and c.started_at >= d0 and c.started_at < d1
    and c.direction in ('outgoing', 'incoming');
  select calls_r + coalesce(range_agg(tstzrange(a.started_at, a.ended_at)), '{}') into calls_r
  from public.activity_segments a where a.org_id = p_org and a.user_id = p_user and a.kind = 'call' and a.started_at >= d0 and a.started_at < d1;
  select coalesce(range_agg(tstzrange(m.sent_at, m.sent_at + make_interval(secs => (s->>'wa_sec')::int))), '{}'), count(*)
    into wa_r, v_wa_n
  from public.wa_messages m where m.org_id = p_org and m.user_id = p_user and m.undone_at is null and m.sent_at >= d0 and m.sent_at < d1;
  select coalesce(range_agg(tstzrange(a.started_at, a.ended_at)) filter (where a.kind = 'crm'), '{}'),
         coalesce(range_agg(tstzrange(a.started_at, a.ended_at)) filter (where a.kind = 'app'), '{}')
    into crm_r, app_r
  from public.activity_segments a where a.org_id = p_org and a.user_id = p_user and a.kind in ('crm', 'app') and a.started_at >= d0 and a.started_at < d1;
  select coalesce(sum(duration_sec) filter (where duration_sec > 0 and direction in ('outgoing', 'incoming')), 0) into v_talk
  from public.calls where org_id = p_org and user_id = p_user and started_at >= d0 and started_at < d1
    and (p_hour is null or extract(hour from started_at at time zone v_tz)::int = p_hour);

  act := calls_r + wa_r + crm_r + app_r;
  -- The working day: Start / End day buttons; forgot → first / last call (then any activity), only
  -- inside working hours (2 h before the shift to 3 h after it), so a late-night personal call
  -- doesn't stretch the day.
  env := tstzmultirange(tstzrange(((p_day::timestamp) + (s->>'shift_start')::time - interval '2 hours') at time zone v_tz,
                                  ((p_day::timestamp) + (s->>'shift_end')::time + interval '3 hours') at time zone v_tz));
  v_start := coalesce(v_pressed_start, lower(calls_r * env), lower(act * env));
  v_end := coalesce(v_pressed_end, case when p_day = (now() at time zone v_tz)::date and v_pressed_start is not null then now() end,
                    greatest(upper(calls_r * env), upper(act * env)));
  if v_start is null or v_end is null or v_end <= v_start then
    return jsonb_build_object('day', p_day, 'worked', false);
  end if;
  w := tstzmultirange(tstzrange(v_start, v_end));
  if p_hour is not null then
    w := w * tstzmultirange(tstzrange(((p_day::timestamp) + make_interval(hours => p_hour)) at time zone v_tz,
                                      ((p_day::timestamp) + make_interval(hours => p_hour + 1)) at time zone v_tz));
  end if;

  -- Breaks (button). A break without "back to work" lasts until the end of the day.
  select coalesce(range_agg(tstzrange(b.at, coalesce(
           (select min(e.at) from public.work_events e where e.org_id = p_org and e.user_id = p_user and e.at > b.at and e.at < d1
              and e.kind in ('break_end', 'day_end', 'break_start')), v_end))), '{}')
    into brk
  from public.work_events b where b.org_id = p_org and b.user_id = p_user and b.kind = 'break_start' and b.at >= d0 and b.at < d1;

  act := act * w;
  brk := (brk * w) - act;          -- calls made during a "break" count as work
  gaps := w - act - brk;
  for g in select unnest(gaps) loop
    if upper(g) - lower(g) >= make_interval(mins => (s->>'idle_min')::int) then idle := idle + tstzmultirange(g);
    else between := between + tstzmultirange(g); end if;
  end loop;
  -- A gap that crosses the hour edge is judged on its full length.
  if p_hour is not null then
    idle := '{}'; between := '{}';
    for g in select unnest((tstzmultirange(tstzrange(v_start, v_end)) - (calls_r + wa_r + crm_r + app_r)
                           - coalesce((select range_agg(tstzrange(b.at, coalesce((select min(e.at) from public.work_events e where e.org_id = p_org and e.user_id = p_user and e.at > b.at and e.at < d1 and e.kind in ('break_end', 'day_end', 'break_start')), v_end)))
                                       from public.work_events b where b.org_id = p_org and b.user_id = p_user and b.kind = 'break_start' and b.at >= d0 and b.at < d1), '{}'))) loop
      if upper(g) - lower(g) >= make_interval(mins => (s->>'idle_min')::int) then idle := idle + (tstzmultirange(g) * w);
      else between := between + (tstzmultirange(g) * w); end if;
    end loop;
  end if;

  v_late := case when v_pressed_start is null and v_start is null then null
                 else greatest(0, extract(epoch from (v_start - (((p_day::timestamp) + (s->>'shift_start')::time) at time zone v_tz)))::int / 60) end;

  return jsonb_build_object(
    'day', p_day, 'worked', true, 'hour', p_hour,
    'start', v_start, 'end', v_end, 'pressed_start', v_pressed_start is not null, 'pressed_end', v_pressed_end is not null,
    'late_min', v_late,
    'window', public.mr_sec(w),
    'calling', public.mr_sec(calls_r * w),
    'talk', v_talk,
    'wa', public.mr_sec((wa_r * w) - calls_r),
    'wa_msgs', v_wa_n,
    'crm', public.mr_sec((crm_r * w) - calls_r - wa_r),
    'app', public.mr_sec((app_r * w) - calls_r - wa_r - crm_r),
    'between', public.mr_sec(between),
    'idle', public.mr_sec(idle),
    'break', public.mr_sec(brk));
end $$;


-- Hour by hour for one person's day (10–11, 11–12 …).
create or replace function public.work_hours(p_org uuid, p_user uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d jsonb; v_tz text; h0 int; h1 int; out jsonb := '[]'; h int;
begin
  if not (public.is_org_member(p_org) and (p_user = auth.uid() or public.can_see_user(p_org, p_user))) then raise exception 'Not allowed'; end if;
  d := public.work_day(p_org, p_user, p_day);
  if not coalesce((d->>'worked')::boolean, false) then return jsonb_build_object('day', d, 'hours', '[]'::jsonb); end if;
  v_tz := public.efficiency_settings(p_org)->>'tz';
  h0 := extract(hour from ((d->>'start')::timestamptz at time zone v_tz))::int;
  h1 := extract(hour from ((d->>'end')::timestamptz at time zone v_tz) - interval '1 second')::int;
  for h in h0..greatest(h0, h1) loop
    out := out || jsonb_build_array(public.work_day(p_org, p_user, p_day, h) || jsonb_build_object('hour', h));
  end loop;
  return jsonb_build_object('day', d, 'hours', out);
end $$;

-- Efficiency of each team member for a period: time split, the 4 scores + overall, lead efficiency.
create or replace function public.efficiency_report(p_org uuid, p_from date, p_to date, p_users uuid[] default null)
returns jsonb language plpgsql volatile security definer set search_path = '' set work_mem = '24MB' as $$
declare
  s jsonb; v_tz text; t0 timestamptz; t1 timestamptz; v_all uuid[]; u uuid; d date; wd jsonb;
  people jsonb := '[]'; v_days jsonb; agg jsonb; m record; tgt int; team record;
  v_time numeric; v_calling numeric; v_conv numeric; v_disc numeric; v_overall numeric; parts numeric[]; wts numeric[];
  late_score numeric; n_days int; n_pressed int; tot jsonb; v_vis uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to < p_from then raise exception 'The end date must be after the start date'; end if;
  if p_to - p_from > 62 then raise exception 'Choose a period of at most 2 months'; end if;
  s := public.efficiency_settings(p_org); v_tz := s->>'tz';
  t0 := (p_from::timestamp) at time zone v_tz; t1 := ((p_to + 1)::timestamp) at time zone v_tz;
  -- Team comparisons use the whole company; only people this user may see are returned.
  v_all := array(select user_id from public.org_members where org_id = p_org);
  v_vis := public.visible_user_ids(p_org);

  -- Call / follow-up / lead numbers per person.
  create temp table if not exists _eff (user_id uuid primary key, dials int, conversations int, lead_calls int, with_outcome int,
    outcome_fast int, positive int, sales int, fu_due int, fu_on_time int, unique_leads int, new_leads int, new_connected int,
    fu_leads int, fu_connected int, days jsonb, days_n int, target_calls int) on commit drop;
  delete from _eff;
  insert into _eff (user_id, dials, conversations, lead_calls, with_outcome, outcome_fast, positive, sales, unique_leads)
  select c.user_id,
    count(*) filter (where c.direction = 'outgoing'),
    count(*) filter (where c.duration_sec > 0 and c.direction in ('outgoing', 'incoming')),
    count(*) filter (where c.lead_id is not null and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.duration_sec > 0))),
    count(*) filter (where c.lead_id is not null and c.outcome_id is not null and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.duration_sec > 0))),
    count(*) filter (where c.lead_id is not null and c.outcome_at is not null and c.outcome_at <= c.started_at + make_interval(secs => c.duration_sec) + interval '10 minutes'),
    count(*) filter (where o.category in ('positive', 'won') and c.duration_sec > 0),
    count(*) filter (where o.category = 'won'),
    count(distinct c.lead_id)
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.org_id = p_org and c.started_at >= t0 and c.started_at < t1 and c.user_id = any(v_all)
  group by c.user_id;
  insert into _eff (user_id) select x from unnest(v_all) x
    where exists (select 1 from public.work_events e where e.org_id = p_org and e.user_id = x and e.at >= t0 and e.at < t1)
  on conflict do nothing;

  update _eff e set fu_due = f.due, fu_on_time = f.on_time, fu_leads = f.leads, fu_connected = f.connected
  from (select f.assigned_to, count(*) as due,
          count(*) filter (where f.dialled_at is not null and f.dialled_at <= f.due_at + interval '15 minutes') as on_time,
          count(distinct f.lead_id) as leads,
          count(distinct f.lead_id) filter (where exists (select 1 from public.calls c where c.lead_id = f.lead_id and c.user_id = f.assigned_to
             and c.duration_sec > 0 and c.started_at between f.due_at - interval '10 minutes' and f.due_at + interval '1 day')) as connected
        from public.follow_ups f
        where f.org_id = p_org and f.due_at >= t0 and f.due_at < least(t1, now() - interval '15 minutes') and f.status <> 'cancelled'
        group by f.assigned_to) f
  where f.assigned_to = e.user_id;
  update _eff e set new_leads = l.n, new_connected = l.c
  from (select l.assigned_to, count(*) as n,
          count(*) filter (where exists (select 1 from public.calls c where c.lead_id = l.id and c.duration_sec > 0 and c.started_at >= t0 and c.started_at < t1)) as c
        from public.leads l where l.org_id = p_org and l.deleted_at is null and l.first_dialled_at >= t0 and l.first_dialled_at < t1
        group by l.assigned_to) l
  where l.assigned_to = e.user_id;
  update _eff e set target_calls = coalesce(
    (select calls from public.rep_targets r where r.org_id = p_org and r.user_id = e.user_id),
    (select calls from public.rep_targets r where r.org_id = p_org and r.user_id is null));

  -- Working days: any day with calls, WhatsApp, app use or Start day.
  for u in select user_id from _eff loop
    v_days := '[]';
    -- People not shown only need their number of working days (for team averages): cheap count.
    if not (u = any(v_vis) and (p_users is null or cardinality(p_users) = 0 or u = any(p_users))) then
      update _eff set days_n = (select count(distinct (started_at at time zone v_tz)::date) from public.calls
        where org_id = p_org and user_id = u and started_at >= t0 and started_at < t1) where user_id = u;
      continue;
    end if;
    for d in select distinct (x at time zone v_tz)::date from (
        select started_at x from public.calls where org_id = p_org and user_id = u and started_at >= t0 and started_at < t1
        union all select at from public.work_events where org_id = p_org and user_id = u and at >= t0 and at < t1
        union all select sent_at from public.wa_messages where org_id = p_org and user_id = u and sent_at >= t0 and sent_at < t1
        union all select started_at from public.activity_segments where org_id = p_org and user_id = u and started_at >= t0 and started_at < t1) q
      order by 1 loop
      wd := public.work_day(p_org, u, d);
      if coalesce((wd->>'worked')::boolean, false) then v_days := v_days || jsonb_build_array(wd); end if;
    end loop;
    update _eff set days = v_days, days_n = jsonb_array_length(v_days) where user_id = u;
  end loop;

  -- Team averages (per working day) for fair comparisons.
  select avg(dials::numeric / nullif(days_n, 0)) as dials_day,
         sum(positive)::numeric / nullif(sum(conversations), 0) as pos_rate,
         sum(sales)::numeric / nullif(sum(conversations), 0) as sale_rate
    into team from _eff where coalesce(days_n, 0) > 0;

  for m in select * from _eff where user_id = any(v_vis) and (p_users is null or cardinality(p_users) = 0 or user_id = any(p_users)) loop
    n_days := jsonb_array_length(coalesce(m.days, '[]'));
    select jsonb_object_agg(k, v) into agg from (
      select k, sum((x->>k)::numeric)::int as v from jsonb_array_elements(coalesce(m.days, '[]')) x,
        unnest(array['window', 'calling', 'talk', 'wa', 'wa_msgs', 'crm', 'app', 'between', 'idle', 'break']) k group by k) z;
    agg := coalesce(agg, '{}');
    select count(*) filter (where (x->>'pressed_start')::boolean),
           avg(case when (x->>'late_min') is null then null when (x->>'late_min')::int <= 5 then 100
                    when (x->>'late_min')::int >= 60 then 0 else 100 - ((x->>'late_min')::int - 5) * 100.0 / 55 end)
      into n_pressed, late_score from jsonb_array_elements(coalesce(m.days, '[]')) x;

    -- 1) Time: productive share of the working day (breaks left out).
    v_time := case when coalesce((agg->>'window')::numeric, 0) - coalesce((agg->>'break')::numeric, 0) > 0
      then least(100, 100 * ((agg->>'window')::numeric - (agg->>'idle')::numeric - (agg->>'break')::numeric)
                       / ((agg->>'window')::numeric - (agg->>'break')::numeric)) end;
    -- 2) Calling: dials vs target (or team average) 40 · follow-ups on time 30 · outcomes filled 30.
    parts := array[
      case when n_days = 0 then null when coalesce(m.target_calls, 0) > 0 then least(100, 100.0 * coalesce(m.dials, 0) / (m.target_calls * n_days))
           when coalesce(team.dials_day, 0) > 0 then least(100, 100.0 * coalesce(m.dials, 0) / n_days / team.dials_day) end,
      case when coalesce(m.fu_due, 0) > 0 then 100.0 * m.fu_on_time / m.fu_due end,
      case when coalesce(m.lead_calls, 0) > 0 then 100.0 * m.with_outcome / m.lead_calls end];
    wts := array[40, 30, 30];
    v_calling := (select sum(p * w) / nullif(sum(w), 0) from unnest(parts, wts) as t(p, w) where p is not null);
    -- 3) Conversion: interested/won per conversation vs team · sales per conversation vs team.
    parts := array[
      case when coalesce(m.conversations, 0) > 0 and coalesce(team.pos_rate, 0) > 0 then least(100, 100.0 * m.positive / m.conversations / team.pos_rate) end,
      case when coalesce(m.conversations, 0) > 0 and coalesce(team.sale_rate, 0) > 0 then least(100, 100.0 * m.sales / m.conversations / team.sale_rate) end];
    v_conv := (select avg(p) from unnest(parts) p where p is not null);
    -- 4) Discipline: on time at start · breaks within allowance · outcomes saved within 10 min · Start day used.
    parts := array[
      late_score,
      case when n_days = 0 then null when coalesce((agg->>'break')::numeric, 0) <= (s->>'break_min')::int * 60 * n_days then 100
           else 100.0 * (s->>'break_min')::int * 60 * n_days / (agg->>'break')::numeric end,
      case when coalesce(m.lead_calls, 0) > 0 then 100.0 * m.outcome_fast / m.lead_calls end,
      case when n_days > 0 then 100.0 * n_pressed / n_days end];
    v_disc := (select avg(p) from unnest(parts) p where p is not null);
    parts := array[v_time, v_calling, v_conv, v_disc];
    wts := array[(s->>'w_time')::numeric, (s->>'w_calling')::numeric, (s->>'w_conversion')::numeric, (s->>'w_discipline')::numeric];
    v_overall := (select sum(p * w) / nullif(sum(w), 0) from unnest(parts, wts) as t(p, w) where p is not null);

    people := people || jsonb_build_array(jsonb_build_object(
      'user_id', m.user_id, 'days_worked', n_days, 'days_started', n_pressed, 'time', agg,
      'productive', coalesce((agg->>'window')::int, 0) - coalesce((agg->>'idle')::int, 0) - coalesce((agg->>'break')::int, 0),
      'scores', jsonb_build_object('time', round(v_time), 'calling', round(v_calling), 'conversion', round(v_conv),
                                   'discipline', round(v_disc), 'overall', round(v_overall)),
      'detail', jsonb_build_object('dials', coalesce(m.dials, 0), 'target_calls', m.target_calls, 'conversations', coalesce(m.conversations, 0),
        'lead_calls', coalesce(m.lead_calls, 0), 'with_outcome', coalesce(m.with_outcome, 0), 'outcome_fast', coalesce(m.outcome_fast, 0),
        'positive', coalesce(m.positive, 0), 'sales', coalesce(m.sales, 0), 'fu_due', coalesce(m.fu_due, 0), 'fu_on_time', coalesce(m.fu_on_time, 0),
        'avg_late_min', (select round(avg((x->>'late_min')::numeric)) from jsonb_array_elements(coalesce(m.days, '[]')) x)),
      'leads', jsonb_build_object('unique', coalesce(m.unique_leads, 0), 'new', coalesce(m.new_leads, 0), 'new_connected', coalesce(m.new_connected, 0),
        'followup', coalesce(m.fu_leads, 0), 'followup_connected', coalesce(m.fu_connected, 0)),
      'days', coalesce(m.days, '[]')));
  end loop;
  return jsonb_build_object('settings', s, 'people', people);
end $$;

revoke all on function public.work_day(uuid, uuid, date, int) from public, anon, authenticated;
grant execute on function public.work_hours(uuid, uuid, date) to authenticated;
grant execute on function public.efficiency_report(uuid, date, date, uuid[]) to authenticated;
grant execute on function public.log_work_events(uuid, jsonb) to authenticated;
grant execute on function public.upload_activity(uuid, jsonb) to authenticated;
grant execute on function public.set_wa_away(uuid, int) to authenticated;
grant execute on function public.efficiency_settings(uuid) to authenticated;
