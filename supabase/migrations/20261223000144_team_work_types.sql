-- Team work (owner, Nov 23): org_members.call_team = none (doesn't call) | sales | reminder | both (null = both, as before);
-- org_members.work_types = the company's own labels (settings.work_types). People who don't call are left out of team
-- lists, leaderboards, reports, summaries, check-ins, lead sharing and automatic lead assignment.
alter table public.org_members drop constraint if exists org_members_call_team_check;
alter table public.org_members add constraint org_members_call_team_check check (call_team is null or call_team in ('none', 'sales', 'reminder', 'both'));
alter table public.org_members add column if not exists work_types text[] not null default '{}';

create or replace function public.set_member_work(p_org uuid, p_user uuid, p jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_org_admin(p_org) then raise exception 'Only the owner or an admin can change this'; end if;
  update public.org_members set
    call_team = case when p ? 'call_team' then nullif(p->>'call_team', '') else call_team end,
    work_types = case when p ? 'work_types' then array(select distinct trim(x) from jsonb_array_elements_text(p->'work_types') x where trim(x) <> '') else work_types end
  where org_id = p_org and user_id = p_user;
  perform public.write_audit(p_org, 'member.work_changed', 'member', p_user::text, p);
end $$;
grant execute on function public.set_member_work(uuid, uuid, jsonb) to authenticated;

CREATE OR REPLACE FUNCTION public.leaderboard(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if coalesce((select (settings->>'show_leaderboard')::boolean from public.organizations where id = p_org), true) = false
     and not public.is_org_manager(p_org) then return '[]'; end if;
  select coalesce(jsonb_agg(x order by (x->>'talk_sec')::int desc), '[]') into res from (
    select jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1)),
      'calls', count(c.id) filter (where c.direction = 'outgoing'),
      'conversations', count(c.id) filter (where c.duration_sec > 0),
      'talk_sec', coalesce(sum(c.duration_sec), 0),
      'sales', (select count(*) from public.sales vs where vs.org_id = p_org and vs.credited_to = m.user_id and vs.status = 'verified'
        and vs.sold_at >= p_from and vs.sold_at < p_to),
      'revenue', (select coalesce(sum(vs.amount), 0) from public.sales vs where vs.org_id = p_org and vs.credited_to = m.user_id and vs.status = 'verified'
        and vs.sold_at >= p_from and vs.sold_at < p_to)) as x
    from public.org_members m join public.profiles p on p.id = m.user_id
    left join public.calls c on c.user_id = m.user_id and c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
    left join public.call_outcomes o on o.id = c.outcome_id
    where m.org_id = p_org and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none'
    group by m.user_id, m.role, p.full_name, p.email
    having m.role in ('rep', 'manager') or count(c.id) > 0) t;
  return res;
end $function$
;

CREATE OR REPLACE FUNCTION public.team_performance(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; v_tz text; v_target int; v_until timestamptz := least(p_to, now()); res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := case when public.is_org_manager(p_org) then public.visible_user_ids(p_org) else array[auth.uid()] end;
  select o.timezone, coalesce(nullif(o.settings->'response'->>'target_min', '')::int, 15) into v_tz, v_target
  from public.organizations o where o.id = p_org;

  with m as (
    select om.user_id, om.call_team, coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1)) as name
    from public.org_members om join public.profiles p on p.id = om.user_id
    where om.org_id = p_org and om.status = 'active' and om.user_id = any(v_users) and coalesce(om.call_team, 'both') <> 'none'
  ),
  k as (
    select c.* from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to and c.user_id = any(v_users)
  ),
  c as (
    select k.user_id,
      count(*) filter (where k.direction = 'outgoing') as dialled,
      count(*) filter (where k.direction = 'outgoing' and k.duration_sec > 30) as answered,
      count(*) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30) as conversations,
      coalesce(sum(k.duration_sec) filter (where k.direction in ('outgoing', 'incoming')), 0) as talk_sec,
      count(*) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30 and k.lead_id is not null) as conv_lead,
      count(*) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30 and k.lead_id is not null
        and (nullif(trim(coalesce(k.notes, '')), '') is not null or jsonb_array_length(coalesce(k.outcome_data->'note_tags', '[]'::jsonb)) > 0)) as conv_noted,
      count(distinct k.lead_id) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30) as leads_talked
    from k group by k.user_id
  ),
  d as (   -- working days with 5+ dialled calls
    select x.user_id, count(*) filter (where x.n >= 5) as active_days from (
      select k.user_id, (k.started_at at time zone v_tz)::date as day, count(*) as n from k where k.direction = 'outgoing' group by 1, 2) x
    group by x.user_id
  ),
  fu as (
    select f.assigned_to as user_id,
      count(*) filter (where f.dialled_at is not null or now() > f.due_at + interval '15 minutes') as due,
      count(*) filter (where f.dialled_at is not null and f.dialled_at <= f.due_at + interval '15 minutes') as on_time
    from public.follow_ups f
    where f.org_id = p_org and f.due_at >= p_from and f.due_at < p_to and f.status <> 'cancelled' and f.assigned_to = any(v_users)
    group by 1
  ),
  la as (   -- leads assigned in the period
    select l.assigned_to as user_id, count(*) as assigned,
      count(*) filter (where l.first_dialled_at is not null) as assigned_called,
      count(*) filter (where l.is_live) as live,
      count(*) filter (where l.is_live and l.response_sec is not null and l.response_sec <= v_target * 60) as live_fast,
      percentile_cont(0.5) within group (order by l.response_sec) filter (where l.is_live and l.response_sec is not null) as resp_median
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and l.assigned_at >= p_from and l.assigned_at < p_to and l.assigned_to = any(v_users)
    group by 1
  ),
  pr as (   -- leads talked to in the period: profession and city filled?
    select k.user_id, count(distinct l.id) as talked,
      count(distinct l.id) filter (where nullif(trim(coalesce(l.profession, '')), '') is not null and nullif(trim(coalesce(l.city, '')), '') is not null) as filled
    from k join public.leads l on l.id = k.lead_id and l.deleted_at is null
    where k.duration_sec > 30 group by 1
  ),
  s as (
    select sa.credited_to as user_id, count(*) as sales, coalesce(sum(sa.amount), 0) as revenue,
      percentile_cont(0.5) within group (order by extract(epoch from sa.sold_at - l.first_dialled_at) / 86400)
        filter (where l.first_dialled_at is not null and sa.sold_at >= l.first_dialled_at) as close_days
    from public.sales sa left join public.leads l on l.id = sa.lead_id
    where sa.org_id = p_org and sa.status = 'verified' and sa.sold_at >= p_from and sa.sold_at < p_to and sa.credited_to = any(v_users)
    group by 1
  ),
  su as (   -- reminder callers: registrants of webinars held in the period
    select coalesce(bl.reminder_by, l.assigned_to) as user_id, count(*) as rem_leads,
      count(*) filter (where coalesce(bl.watch_minutes, 0) > 0) as rem_joined,
      count(*) filter (where coalesce(bl.watch_minutes, 0) > 0 and bl.watch_minutes >= b.hot_minutes) as rem_stayed,
      count(*) filter (where sp.spoke) as rem_spoke,
      count(*) filter (where sp.spoke and coalesce(bl.watch_minutes, 0) > 0) as rem_spoke_joined
    from public.batch_leads bl
    join public.batches b on b.id = bl.batch_id
    join public.leads l on l.id = bl.lead_id and l.deleted_at is null
    left join lateral (select exists (select 1 from public.calls rc where rc.batch_id = bl.batch_id and rc.lead_id = bl.lead_id
      and rc.purpose = 'reminder' and rc.started_at < b.webinar_at and rc.duration_sec > 30) as spoke) sp on true
    where b.org_id = p_org and b.webinar_at >= p_from and b.webinar_at < p_to and b.zoom_uploaded_at is not null
      and bl.registered and not bl.is_holdout and coalesce(bl.reminder_by, l.assigned_to) = any(v_users)
    group by 1
  ),
  rows as (
    select m.user_id, m.name, m.call_team,
      coalesce(c.dialled, 0) dialled, coalesce(c.answered, 0) answered, coalesce(c.conversations, 0) conversations,
      coalesce(c.talk_sec, 0) talk_sec, coalesce(c.leads_talked, 0) leads_talked,
      coalesce(s.sales, 0) sales, coalesce(s.revenue, 0) revenue, round(s.close_days::numeric, 1) close_days,
      coalesce(la.assigned, 0) assigned, coalesce(la.assigned_called, 0) assigned_called,
      coalesce(la.live, 0) live, coalesce(la.live_fast, 0) live_fast, round((la.resp_median / 60)::numeric) resp_median_min,
      coalesce(fu.due, 0) fu_due, coalesce(fu.on_time, 0) fu_on_time,
      coalesce(c.conv_lead, 0) conv_lead, coalesce(c.conv_noted, 0) conv_noted,
      coalesce(pr.talked, 0) profile_talked, coalesce(pr.filled, 0) profile_filled,
      coalesce(d.active_days, 0) active_days,
      greatest(public.working_days(p_org, m.user_id, (p_from at time zone v_tz)::date, ((v_until - interval '1 second') at time zone v_tz)::date), 0) work_days,
      coalesce(su.rem_leads, 0) rem_leads, coalesce(su.rem_joined, 0) rem_joined, coalesce(su.rem_stayed, 0) rem_stayed,
      coalesce(su.rem_spoke, 0) rem_spoke, coalesce(su.rem_spoke_joined, 0) rem_spoke_joined
    from m
    left join c on c.user_id = m.user_id left join d on d.user_id = m.user_id left join fu on fu.user_id = m.user_id
    left join la on la.user_id = m.user_id left join pr on pr.user_id = m.user_id left join s on s.user_id = m.user_id
    left join su on su.user_id = m.user_id
  ),
  scored as (
    select r.*,
      case when r.conv_lead > 0 then round(r.conv_noted * 100.0 / r.conv_lead) end notes_pct,
      case when r.fu_due > 0 then round(r.fu_on_time * 100.0 / r.fu_due) end fu_pct,
      case when r.live > 0 then round(r.live_fast * 100.0 / r.live) end fast_pct,
      case when r.assigned > 0 then round(r.assigned_called * 100.0 / r.assigned) end called_pct,
      case when r.profile_talked > 0 then round(r.profile_filled * 100.0 / r.profile_talked) end profile_pct,
      -- Days with 5+ calls only count for someone who worked leads in the period (an owner who doesn't call gets no marks, not 0).
      case when r.work_days > 0 and (r.dialled > 0 or r.assigned > 0 or r.fu_due > 0) then round(least(r.active_days, r.work_days) * 100.0 / r.work_days) end active_pct,
      case when r.dialled > 0 then round(r.answered * 100.0 / r.dialled) end pickup_pct,
      case when r.leads_talked > 0 then round(r.sales * 100.0 / r.leads_talked, 1) end close_pct,
      case when r.rem_leads > 0 then round(r.rem_joined * 100.0 / r.rem_leads) end showup_pct,
      case when r.rem_spoke > 0 then round(r.rem_spoke_joined * 100.0 / r.rem_spoke) end spoke_showup_pct
    from rows r
  )
  select jsonb_build_object(
    'target_min', v_target,
    'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.talk_sec desc), '[]'::jsonb)
  ) into res
  from (select sc.*,
          (select round(avg(v)) from unnest(array[sc.notes_pct, sc.fu_pct, sc.fast_pct, sc.called_pct, sc.profile_pct, sc.active_pct]) v where v is not null) as hygiene
        from scored sc) x;
  return res;
end $function$
;

CREATE OR REPLACE FUNCTION public.daily_summary(p_org uuid, p_kind text, p_day date DEFAULT NULL::date, p_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'people', case when v_team then coalesce((select jsonb_agg(jsonb_build_object('user_id', u, 'name', p.full_name, 'email', p.email, 'stats', public.day_stats(p_org, array[u], a, b, v_tz))
                  order by p.full_name)
                from unnest(v_users) u join public.profiles p on p.id = u
                join public.org_members m on m.org_id = p_org and m.user_id = u and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none'), '[]') else null end,
    'plan', jsonb_build_object(
      'follow_ups', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending' and due_at >= pa and due_at < pb),
      'overdue', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending' and due_at < pa),
      'hot', public.hot_leads(p_org, v_users, 50),
      'no_next', (select count(*) from public.leads l join public.call_outcomes o on o.id = l.last_outcome_id
               where l.org_id = p_org and l.assigned_to = any(v_users) and l.deleted_at is null and l.won_at is null
                 and o.category = 'positive' and l.next_follow_up_at is null),
      'webinars', coalesce((select jsonb_agg(jsonb_build_object('name', bb.name, 'at', bb.webinar_at,
                 'leads', (select count(*) from public.batch_leads bl join public.leads l on l.id = bl.lead_id
                           where bl.batch_id = bb.id and coalesce(bl.reminder_by, l.assigned_to) = any(v_users))) order by bb.webinar_at)
                 from public.batches bb where bb.org_id = p_org and not bb.is_archived and bb.webinar_at >= pa and bb.webinar_at < pb), '[]'))
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.dashboard_data(p_org uuid, p_period text DEFAULT 'today'::text, p_team uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_mgr boolean; v_users uuid[]; v_all uuid[]; d0 date; a timestamptz; b timestamptz; pa timestamptz; pb timestamptz;
  v_me uuid := auth.uid(); r jsonb := '{}';
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_mgr := public.is_org_manager(p_org);
  v_users := case when v_mgr then public.visible_user_ids(p_org) else array[v_me] end;
  if v_mgr and p_team is not null then
    v_users := array(select u from unnest(v_users) u where u in (select user_id from public.team_members where team_id = p_team));
  end if;
  select array_agg(user_id) into v_all from public.org_members where org_id = p_org and status = 'active' and coalesce(call_team, 'both') <> 'none';
  d0 := (now() at time zone v_tz)::date;
  if p_period = 'yesterday' then
    a := (d0 - 1)::timestamp at time zone v_tz; b := d0::timestamp at time zone v_tz; pa := a - interval '1 day'; pb := a;
  elsif p_period = '7d' then
    a := (d0 - 6)::timestamp at time zone v_tz; b := now(); pa := a - interval '7 days'; pb := now() - interval '7 days';
  else
    a := d0::timestamp at time zone v_tz; b := now(); pa := a - interval '1 day'; pb := now() - interval '1 day';
  end if;

  r := jsonb_build_object('manager', v_mgr, 'from', a, 'to', b, 'tz', v_tz,
    'kpi', public.day_stats(p_org, v_users, a, b, v_tz),
    'prev', public.day_stats(p_org, v_users, pa, pb, v_tz));

  -- per person (whole company for the comparison; rows outside what the viewer may see carry activity only)
  r := r || jsonb_build_object('people', coalesce((
    with c as (
      select c.user_id, c.direction::text dir, c.duration_sec, c.started_at, c.outcome_id, coalesce(c.lead_id::text, public.phone_key(c.phone)) who
      from public.calls c where c.org_id = p_org and c.user_id = any(v_all) and c.started_at >= a and c.started_at < b
    ), s as (
      select credited_to u, count(*) n, coalesce(sum(amount), 0) amt from public.sales
      where org_id = p_org and status = 'verified' and sold_at >= a and sold_at < b group by 1
    ), dv as (
      select distinct on (user_id) user_id, updated_at, coalesce((setup->>'overlay')::boolean, true) overlay, app_version
      from public.device_status where org_id = p_org order by user_id, updated_at desc
    )
    select jsonb_agg(jsonb_build_object('user_id', m.u, 'mine', m.u = any(v_users),
      'dialled', coalesce(x.dialled, 0), 'connected', coalesce(x.connected, 0), 'leads_connected', coalesce(x.lc, 0),
      'talk', coalesce(x.talk, 0), 'conv', coalesce(x.conv, 0),
      'outcomes', case when m.u = any(v_users) then coalesce(x.oc, 0) end,
      'last_call', case when m.u = any(v_users) then x.last_call end,
      'sales', case when m.u = any(v_users) then coalesce(s.n, 0) end, 'revenue', case when m.u = any(v_users) then coalesce(s.amt, 0) end,
      'synced', case when m.u = any(v_users) then dv.updated_at end,
      'popup_off', case when m.u = any(v_users) then dv.overlay = false end, 'app', case when m.u = any(v_users) then dv.app_version end))
    from unnest(v_all) m(u)
    left join (select user_id,
        count(*) filter (where dir = 'outgoing') dialled,
        count(*) filter (where dir = 'outgoing' and duration_sec > 0) connected,
        count(distinct who) filter (where duration_sec > 0 and dir in ('incoming','outgoing')) lc,
        coalesce(sum(duration_sec) filter (where dir in ('incoming','outgoing')), 0) talk,
        count(*) filter (where duration_sec > 0 and dir in ('incoming','outgoing')) conv,
        count(*) filter (where duration_sec > 0 and dir in ('incoming','outgoing') and outcome_id is not null) oc,
        max(started_at) last_call
      from c group by 1) x on x.user_id = m.u
    left join s on s.u = m.u left join dv on dv.user_id = m.u
    where m.u = any(v_users) or exists (select 1 from public.org_members om where om.org_id = p_org and om.user_id = m.u and om.role in ('rep','manager'))
  ), '[]'));

  -- what needs attention now
  r := r || jsonb_build_object('attention', jsonb_build_object(
    'unassigned', case when v_mgr then (select count(*) from public.leads where org_id = p_org and deleted_at is null and assigned_to is null
        and created_at > now() - interval '7 days') end,
    'no_outcome', (select count(*) from public.calls where org_id = p_org and user_id = any(v_users) and started_at >= d0::timestamp at time zone v_tz
        and duration_sec > 0 and direction in ('incoming','outgoing') and outcome_id is null and not from_history and lead_id is not null),
    'fu_due', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending'
        and due_at <= now() + interval '1 hour' and due_at >= d0::timestamp at time zone v_tz),
    'fu_overdue', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending'
        and due_at < d0::timestamp at time zone v_tz and due_at > now() - interval '30 days')));

  -- webinars: next one (reminder progress) + last one (sales calls after it)
  r := r || jsonb_build_object('webinars', coalesce((
    with bt as (
      select b.id, b.name, b.webinar_at from public.batches b where b.org_id = p_org and not b.is_archived and b.webinar_at is not null
        and b.webinar_at > now() - interval '7 days' and b.webinar_at < now() + interval '3 days'
    ), pick as (
      (select id, 'next' k from bt where webinar_at > now() order by webinar_at limit 1)
      union all (select id, 'last' from bt where webinar_at <= now() order by webinar_at desc limit 1)
    )
    select jsonb_agg(jsonb_build_object('kind', p.k, 'id', b.id, 'name', b.name, 'at', b.webinar_at,
      'leads', (select count(*) from public.batch_leads bl join public.leads l on l.id = bl.lead_id and l.deleted_at is null
                where bl.batch_id = b.id and not coalesce(bl.is_holdout, false) and (l.assigned_to = any(v_users) or bl.reminder_by = any(v_users))
                  and (p.k = 'next' or coalesce(bl.watch_minutes, 0) > 0 or bl.attended)),
      'called', (select count(distinct c.lead_id) from public.calls c where c.batch_id = b.id and c.user_id = any(v_users)
                and c.purpose = case when p.k = 'next' then 'reminder' else 'sales' end and (p.k = 'last' or c.started_at < b.webinar_at)),
      'talked', (select count(distinct c.lead_id) from public.calls c where c.batch_id = b.id and c.user_id = any(v_users) and c.duration_sec > 30
                and c.purpose = case when p.k = 'next' then 'reminder' else 'sales' end and (p.k = 'last' or c.started_at < b.webinar_at)),
      'by', coalesce((select jsonb_agg(jsonb_build_object('user_id', z.user_id, 'leads', z.n, 'talked', z.t) order by z.n desc) from (
                select c.user_id, count(distinct c.lead_id) n, count(distinct c.lead_id) filter (where c.duration_sec > 30) t from public.calls c
                where c.batch_id = b.id and c.user_id = any(v_users) and c.purpose = case when p.k = 'next' then 'reminder' else 'sales' end
                  and (p.k = 'last' or c.started_at < b.webinar_at) group by 1) z), '[]')) order by p.k desc)
    from pick p join bt b on b.id = p.id), '[]'));

  r := r || jsonb_build_object('hot', public.hot_leads(p_org, v_users, 5));
  return r;
end $function$
;

CREATE OR REPLACE FUNCTION public.team_checkins(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where m.org_id = p_org and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none' and public.can_see_user(p_org, m.user_id)
    group by m.user_id, p.full_name) z), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.org_people(p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when public.is_org_member(p_org) then coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id,
      'name', coalesce(nullif(p.full_name, ''), p.email), 'role', m.role) order by coalesce(nullif(p.full_name, ''), p.email)), '[]') end
  from public.org_members m join public.profiles p on p.id = m.user_id
  where m.org_id = p_org and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none';
$function$
;

CREATE OR REPLACE FUNCTION public.team_brief(p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(p.full_name, ''), p.email)) order by p.full_name), '[]')
  from public.org_members m join public.profiles p on p.id = m.user_id
  where m.org_id = p_org and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none' and m.user_id = any(public.visible_user_ids(p_org)) and public.is_org_member(p_org)
$function$
;

CREATE OR REPLACE FUNCTION public.target_progress(p_org uuid, p_from date, p_to date, p_users uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    from public.org_members m where m.org_id = p_org and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none' and m.user_id = any(v_users)
  ), t as (
    select p.user_id, p.days,
      coalesce(r.calls, d.calls) as calls, coalesce(r.conversations, d.conversations) as conversations,
      coalesce(r.talk_minutes, d.talk_minutes) as talk_minutes, coalesce(r.sales, d.sales) as sales, coalesce(r.focus_leads, d.focus_leads) as focus,
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
      'daily', jsonb_build_object('calls', t.calls, 'conversations', t.conversations, 'talk_minutes', t.talk_minutes, 'sales', t.sales, 'focus', t.focus),
      'actual', jsonb_build_object('calls', coalesce(a.calls, 0), 'conversations', coalesce(a.conversations, 0),
                                   'talk_minutes', coalesce(a.talk_minutes, 0),
                                   -- verified sales credited to this person (not just "won" outcomes)
                                   'sales', (select count(*) from public.sales vs where vs.org_id = p_org and vs.credited_to = t.user_id and vs.status = 'verified'
                                     and vs.sold_at >= (p_from::timestamp at time zone v_tz) and vs.sold_at < ((p_to + 1)::timestamp at time zone v_tz)))
    )), '[]'::jsonb) into res
  from t left join a on a.user_id = t.user_id;
  return jsonb_build_object('work_days', v_days, 'rows', res);
end $function$
;

CREATE OR REPLACE FUNCTION public.pick_assignee(p_org uuid, p_lead leads)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; k text; v text; ok boolean; pool uuid[]; chosen uuid;
begin
  for r in
    select * from public.distribution_rules
    where org_id = p_org and is_active and method <> 'manual'
    order by priority, created_at
    for update
  loop
    ok := true;
    if r.method = 'rule' then
      for k, v in select * from jsonb_each_text(r.conditions) loop
        if lower(coalesce(to_jsonb(p_lead)->>k, p_lead.custom->>k, '')) <> lower(v) then ok := false; end if;
      end loop;
    end if;
    continue when not ok;

    -- Only active members of the company can receive leads.
    select array_agg(u order by ord) into pool
    from unnest(r.user_ids) with ordinality as t(u, ord)
    where exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = u and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none');
    continue when pool is null or cardinality(pool) = 0;

    chosen := pool[(r.rr_cursor % cardinality(pool)) + 1];
    update public.distribution_rules set rr_cursor = rr_cursor + 1 where id = r.id;
    return chosen;
  end loop;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.source_rule_pick(s lead_sources, p_member uuid, p_advance boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; n int; pos int;
begin
  if p_member is not null then return p_member; end if;
  if s.assign_mode = 'users' then
    select array_agg(u order by ord) into v_users from unnest(s.assign_users) with ordinality as x(u, ord)
    where exists (select 1 from public.org_members om where om.org_id = s.org_id and om.user_id = x.u and om.status = 'active' and coalesce(om.call_team, 'both') <> 'none');
    n := coalesce(array_length(v_users, 1), 0);
    if n = 0 then return null; end if;
    if p_advance then
      update public.lead_sources set rr_pos = rr_pos + 1 where id = s.id returning rr_pos into pos;
    else pos := s.rr_pos + 1; end if;
    return v_users[((pos - 1) % n) + 1];
  elsif s.assign_mode = 'user' then return s.assign_to;
  end if;
  return null;
end $function$
;
