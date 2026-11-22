-- New Dashboard (Nov 22): one call per page load. Owner/admin = company (+ team filter), manager = own teams, rep = own data
-- + activity comparison with the whole team (leaderboard, me vs team average). Period today | yesterday | 7d, compared with
-- the same span before (today = up to the same clock time yesterday).
create or replace function public.dashboard_data(p_org uuid, p_period text default 'today', p_team uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
  select array_agg(user_id) into v_all from public.org_members where org_id = p_org and status = 'active';
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
end $$;
grant execute on function public.dashboard_data(uuid, text, uuid) to authenticated;
