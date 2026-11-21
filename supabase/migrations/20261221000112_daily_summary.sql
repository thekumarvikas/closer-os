-- Daily summaries (owner, Nov 21 2026): morning 8:00 AM (yesterday + today's plan), evening 9:30 PM (today + tomorrow's plan).
-- Reps: themselves. Managers: the team total + each person (p_user null) or one person.
create or replace function public.day_stats(p_org uuid, p_users uuid[], p_from timestamptz, p_to timestamptz, p_tz text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with c as (
    select c.*, o.category, o.code from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.user_id = any(p_users) and c.started_at >= p_from and c.started_at < p_to
  ), h as (
    select extract(hour from started_at at time zone p_tz)::int hr, count(*) filter (where duration_sec > 0 and direction in ('incoming','outgoing')) conn,
      coalesce(sum(duration_sec) filter (where duration_sec > 0 and direction in ('incoming','outgoing')), 0) talk,
      count(*) filter (where category in ('positive','won')) pos
    from c group by 1
  ), f as (
    select * from public.follow_ups where org_id = p_org and assigned_to = any(p_users) and due_at >= p_from and due_at < p_to and status <> 'cancelled'
  ), s as (
    select * from public.sales where org_id = p_org and status = 'verified' and credited_to = any(p_users) and sold_at >= p_from and sold_at < p_to
  )
  select jsonb_build_object(
    'dialled', (select count(*) from c where direction = 'outgoing'),
    'connected', (select count(*) from c where direction = 'outgoing' and duration_sec > 0),
    'received', (select count(*) from c where direction = 'incoming'),
    'missed', (select count(*) from c where direction in ('missed','rejected')),
    'missed_open', (select count(distinct public.phone_key(m.phone)) from c m where m.direction in ('missed','rejected') and coalesce(m.phone,'') <> ''
        and not exists (select 1 from public.calls r where r.org_id = p_org and public.phone_key(r.phone) = public.phone_key(m.phone) and r.started_at > m.started_at
          and (r.direction = 'outgoing' or (r.direction = 'incoming' and r.duration_sec > 0)))),
    'conversations', (select count(*) from c where duration_sec > 0 and direction in ('incoming','outgoing')),
    'talk', (select coalesce(sum(duration_sec), 0) from c where direction in ('incoming','outgoing')),
    'leads', (select count(distinct lead_id) from c where lead_id is not null),
    'interested', (select count(*) from c where category = 'positive'),
    'call_later', (select count(*) from c where code ~ 'call_back|call_later'),
    'sales', (select count(*) from s), 'revenue', (select coalesce(sum(amount), 0) from s),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('hr', hr, 'conn', conn, 'talk', talk, 'pos', pos)) from h), '[]'),
    'fu_due', (select count(*) from f),
    'fu_on_time', (select count(*) from f where dialled_at is not null and dialled_at <= due_at + interval '15 minutes'),
    'fu_late', (select count(*) from f where dialled_at > due_at + interval '15 minutes'),
    'fu_missed', (select count(*) from f where dialled_at is null and due_at + interval '15 minutes' < now()))
$$;
revoke all on function public.day_stats(uuid, uuid[], timestamptz, timestamptz, text) from public, anon, authenticated;

create or replace function public.daily_summary(p_org uuid, p_kind text, p_day date default null, p_user uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_day date; v_plan date; a timestamptz; b timestamptz; pa timestamptz; pb timestamptz; v_team boolean;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_team := public.is_org_manager(p_org) and p_user is null;
  if v_team then v_users := public.visible_user_ids(p_org);
  elsif p_user is not null and p_user <> auth.uid() then
    if not (p_user = any(public.visible_user_ids(p_org))) then raise exception 'Not allowed'; end if;
    v_users := array[p_user];
  else v_users := array[auth.uid()]; end if;
  -- morning: results of yesterday + plan for today · evening: results of today + plan for tomorrow
  v_day := coalesce(p_day, (now() at time zone v_tz)::date - case when p_kind = 'morning' then 1 else 0 end);
  v_plan := v_day + 1;
  a := v_day::timestamp at time zone v_tz; b := (v_day + 1)::timestamp at time zone v_tz;
  pa := v_plan::timestamp at time zone v_tz; pb := (v_plan + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'kind', p_kind, 'day', v_day, 'plan_day', v_plan, 'tz', v_tz, 'team', v_team,
    'org_name', (select name from public.organizations where id = p_org),
    'who', case when v_team then null else (select full_name from public.profiles where id = v_users[1]) end,
    'working_day', exists (select 1 from public.working_days(p_org, case when v_team then null else v_users[1] end, v_plan, v_plan)),
    'stats', public.day_stats(p_org, v_users, a, b, v_tz),
    'people', case when v_team then coalesce((select jsonb_agg(jsonb_build_object('user_id', u, 'name', p.full_name, 'stats', public.day_stats(p_org, array[u], a, b, v_tz))
                  order by p.full_name)
                from unnest(v_users) u join public.profiles p on p.id = u
                join public.org_members m on m.org_id = p_org and m.user_id = u and m.status = 'active'), '[]') else null end,
    'plan', jsonb_build_object(
      'follow_ups', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending' and due_at >= pa and due_at < pb),
      'overdue', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending' and due_at < pa),
      'hot', (select count(distinct l.id) from public.leads l where l.org_id = p_org and l.assigned_to = any(v_users) and l.deleted_at is null and l.won_at is null
               and (l.intent in ('ready','hot') or exists (select 1 from public.batch_leads bl join public.batches bb on bb.id = bl.batch_id
                 where bl.lead_id = l.id and bl.warmth >= 70 and bb.webinar_at > now() - interval '14 days'))),
      'webinars', coalesce((select jsonb_agg(jsonb_build_object('name', bb.name, 'at', bb.webinar_at,
                 'leads', (select count(*) from public.batch_leads bl join public.leads l on l.id = bl.lead_id
                           where bl.batch_id = bb.id and coalesce(bl.reminder_by, l.assigned_to) = any(v_users))) order by bb.webinar_at)
                 from public.batches bb where bb.org_id = p_org and not bb.is_archived and bb.webinar_at >= pa and bb.webinar_at < pb), '[]'))
  );
end $$;
grant execute on function public.daily_summary(uuid, text, date, uuid) to authenticated;
