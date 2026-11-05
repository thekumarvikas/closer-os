-- Hourly check-ins: each rep's phone posts a progress card every working hour (computed on the phone);
-- the rep acknowledges it. Records (best talk-time hour) and the manager's team view come from here.

create table if not exists public.checkin_acks (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slot timestamptz not null,                 -- the hour the check-in was for
  summary jsonb not null default '{}'::jsonb, -- what the rep saw (status, last hour, today, reminder maths)
  shown_at timestamptz,
  acked_at timestamptz,
  primary key (user_id, slot)
);
create index if not exists checkin_acks_org_slot on public.checkin_acks (org_id, slot desc);
alter table public.checkin_acks enable row level security;
drop policy if exists checkin_acks_read on public.checkin_acks;
create policy checkin_acks_read on public.checkin_acks for select using (
  user_id = auth.uid() or (public.is_org_member(org_id) and public.can_see_user(org_id, user_id)));

create or replace function public.save_checkin(p_org uuid, p_slot timestamptz, p_summary jsonb, p_acked boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  insert into public.checkin_acks (org_id, user_id, slot, summary, shown_at, acked_at)
  values (p_org, auth.uid(), p_slot, coalesce(p_summary, '{}'), now(), case when p_acked then now() end)
  on conflict (user_id, slot) do update set
    summary = case when excluded.summary <> '{}'::jsonb then excluded.summary else public.checkin_acks.summary end,
    acked_at = coalesce(public.checkin_acks.acked_at, excluded.acked_at);
end $$;

-- My best talk-time hours ever (clock hours in the company time zone): the record and the top 3.
create or replace function public.my_talk_records(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with tz as (select timezone from public.organizations where id = p_org),
  h as (
    select date_trunc('hour', c.started_at at time zone (select timezone from tz)) hr, sum(c.duration_sec)::int talk
    from public.calls c
    where c.org_id = p_org and c.user_id = auth.uid() and c.direction in ('incoming', 'outgoing') and c.duration_sec > 0
      and public.is_org_member(p_org)
    group by 1)
  select jsonb_build_object('top', coalesce((select jsonb_agg(jsonb_build_object('hour', to_char(hr, 'YYYY-MM-DD"T"HH24:00'), 'talk_sec', talk)) from
          (select * from h order by talk desc limit 3) t), '[]'::jsonb))
$$;

-- Manager view: each person's last hour, today, best hour today, all-time best, and the latest check-in.
create or replace function public.team_checkins(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_day timestamptz; v_hr timestamptz;
begin
  if not public.is_org_manager(p_org) then raise exception 'Managers only'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_day := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_hr := date_trunc('hour', now() at time zone v_tz) at time zone v_tz;   -- this clock hour; "last hour" = the one before
  return coalesce((select jsonb_agg(r order by (r->>'today_talk')::int desc) from (
    select jsonb_build_object(
      'user_id', m.user_id, 'name', p.full_name,
      'today_dialled', count(c.id) filter (where c.direction = 'outgoing'),
      'today_connected', count(c.id) filter (where c.duration_sec > 0 and c.direction in ('incoming', 'outgoing')),
      'today_talk', coalesce(sum(c.duration_sec) filter (where c.direction in ('incoming', 'outgoing')), 0),
      'today_sales', count(c.id) filter (where o.category = 'won'),
      'last_dialled', count(c.id) filter (where c.direction = 'outgoing' and c.started_at >= v_hr - interval '1 hour' and c.started_at < v_hr),
      'last_connected', count(c.id) filter (where c.duration_sec > 0 and c.direction in ('incoming', 'outgoing') and c.started_at >= v_hr - interval '1 hour' and c.started_at < v_hr),
      'last_talk', coalesce(sum(c.duration_sec) filter (where c.direction in ('incoming', 'outgoing') and c.started_at >= v_hr - interval '1 hour' and c.started_at < v_hr), 0),
      'best_today', (select max(t) from (select sum(c2.duration_sec) t from public.calls c2 where c2.org_id = p_org and c2.user_id = m.user_id
                      and c2.started_at >= v_day and c2.direction in ('incoming', 'outgoing') group by date_trunc('hour', c2.started_at at time zone v_tz)) x),
      'best_ever', (select max(t) from (select sum(c3.duration_sec) t from public.calls c3 where c3.org_id = p_org and c3.user_id = m.user_id
                      and c3.direction in ('incoming', 'outgoing') group by date_trunc('hour', c3.started_at at time zone v_tz)) y),
      'checkin', (select jsonb_build_object('slot', a.slot, 'acked_at', a.acked_at, 'status', a.summary->>'status', 'headline', a.summary->>'title')
                  from public.checkin_acks a where a.user_id = m.user_id and a.org_id = p_org order by a.slot desc limit 1),
      'checkins_today', (select count(*) from public.checkin_acks a where a.user_id = m.user_id and a.org_id = p_org and a.slot >= v_day),
      'acked_today', (select count(*) from public.checkin_acks a where a.user_id = m.user_id and a.org_id = p_org and a.slot >= v_day and a.acked_at is not null)
    ) r
    from public.org_members m
    join public.profiles p on p.id = m.user_id
    left join public.calls c on c.org_id = p_org and c.user_id = m.user_id and c.started_at >= v_day
    left join public.call_outcomes o on o.id = c.outcome_id
    where m.org_id = p_org and m.status = 'active' and public.can_see_user(p_org, m.user_id)
    group by m.user_id, p.full_name) z), '[]'::jsonb);
end $$;
grant execute on function public.save_checkin(uuid, timestamptz, jsonb, boolean), public.my_talk_records(uuid), public.team_checkins(uuid) to authenticated;
