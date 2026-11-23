-- "Clear old outcomes" (owner, Nov 23): a manager clears the backlog of calls without an outcome for a team member (or the
-- whole team) up to a cut-off. Cleared calls get a grey "No outcome — cleared by manager" label, never count as missing, and the
-- app stops asking about them (calls_with_outcome returns them as done — works with app versions already installed).
-- Calls after the cut-off still need an outcome. Every clearing is audit-logged. A real outcome can still be added later.
alter table public.calls add column if not exists outcome_cleared_at timestamptz, add column if not exists outcome_cleared_by uuid;
alter table public.org_members add column if not exists outcome_from timestamptz;

create or replace function public.clear_outcomes(p_org uuid, p_users uuid[], p_cutoff timestamptz, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_users uuid[]; n int;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can clear outcomes'; end if;
  v_users := array(select u from unnest(coalesce(p_users, public.visible_user_ids(p_org))) u where public.can_see_user(p_org, u));
  select count(*) into n from public.calls
   where org_id = p_org and user_id = any(v_users) and outcome_id is null and outcome_cleared_at is null and not from_history
     and started_at < p_cutoff and duration_sec >= 0 and direction in ('incoming', 'outgoing');
  if p_preview then return jsonb_build_object('calls', n, 'people', cardinality(v_users)); end if;
  update public.calls set outcome_cleared_at = now(), outcome_cleared_by = auth.uid()
   where org_id = p_org and user_id = any(v_users) and outcome_id is null and outcome_cleared_at is null and not from_history
     and started_at < p_cutoff and direction in ('incoming', 'outgoing');
  update public.org_members set outcome_from = greatest(coalesce(outcome_from, p_cutoff), p_cutoff)
   where org_id = p_org and user_id = any(v_users);
  perform public.write_audit(p_org, 'outcomes.cleared', 'member', null,
    jsonb_build_object('users', to_jsonb(v_users), 'cutoff', p_cutoff, 'calls', n));
  -- ask their phones to check again now
  begin perform public.push_wake(p_org, u, 'sync') from unnest(v_users) u; exception when others then null; end;
  return jsonb_build_object('calls', n, 'people', cardinality(v_users));
end $$;
grant execute on function public.clear_outcomes(uuid, uuid[], timestamptz, boolean) to authenticated;

-- A call cleared by a manager, or made before the person's "outcomes from" time, counts as done for the app.
create or replace function public.calls_with_outcome(p_ids uuid[]) returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(c.id), '{}') from public.calls c
  left join public.org_members m on m.org_id = c.org_id and m.user_id = c.user_id
  where c.id = any(p_ids) and c.user_id = auth.uid()
    and (c.outcome_id is not null or c.outcome_cleared_at is not null or c.started_at < m.outcome_from)
$$;

-- New calls synced in for a time before the cut-off (phone was offline) are cleared too.
create or replace function public.t_call_before_outcome_from() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.outcome_id is null and new.outcome_cleared_at is null and exists (select 1 from public.org_members m
       where m.org_id = new.org_id and m.user_id = new.user_id and m.outcome_from is not null and new.started_at < m.outcome_from) then
    new.outcome_cleared_at := now();
  end if;
  return new;
end $$;
drop trigger if exists t_call_before_outcome_from on public.calls;
create trigger t_call_before_outcome_from before insert on public.calls for each row execute function public.t_call_before_outcome_from();

CREATE OR REPLACE FUNCTION public.outcome_report(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_users uuid[] DEFAULT NULL::uuid[], p_dirs text[] DEFAULT NULL::text[], p_channels text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '24MB'
AS $function$
declare v_tz text; v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to <= p_from then raise exception 'The end date must be after the start date'; end if;
  if p_to - p_from > interval '93 days' then raise exception 'Choose a period of at most 3 months'; end if;

  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then
    v_users := array(select unnest(v_users) intersect select unnest(p_users));
  end if;

  with c as (
    select c.user_id, c.lead_id, coalesce(c.outcome_id, case when c.outcome_cleared_at is not null then '00000000-0000-0000-0000-000000000002'::uuid when c.from_history then '00000000-0000-0000-0000-000000000001'::uuid end) outcome_id, c.duration_sec,
      (c.started_at at time zone v_tz)::date as day,
      coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) as amount,
      coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) as deal_value
    from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
      and c.user_id = any(v_users) and c.lead_id is not null
      and (p_dirs is null or c.direction::text = any(p_dirs))
      and (p_channels is null or c.channel = any(p_channels))
  ),
  agg as (
    select grouping(user_id, day, outcome_id) as g, user_id, day, outcome_id,
      count(*) as calls,
      count(distinct lead_id) as leads,
      sum(amount) as amount,
      sum(deal_value) as deal_value,
      coalesce(sum(duration_sec), 0) as dur
    from c
    group by grouping sets ((outcome_id), (user_id, outcome_id), (day, outcome_id), (user_id), (day), ())
  )
  select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(agg)), '[]'::jsonb)) into res from agg;
  return res;
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
        and duration_sec > 0 and direction in ('incoming','outgoing') and outcome_id is null and outcome_cleared_at is null and not from_history and lead_id is not null),
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

CREATE OR REPLACE FUNCTION public.my_calls_needing_outcome(p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'lead_id', c.lead_id, 'lead_name', l.name, 'phone', c.phone, 'direction', c.direction,
    'started_at', c.started_at, 'duration_sec', c.duration_sec, 'purpose', c.purpose, 'batch_id', c.batch_id, 'sim_slot', c.sim_slot) order by c.started_at desc), '[]')
  from public.calls c join public.leads l on l.id = c.lead_id
  where c.org_id = p_org and c.user_id = auth.uid() and c.outcome_id is null and c.outcome_cleared_at is null and c.started_at > now() - interval '24 hours'
    and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.duration_sec > 0))
$function$
;
