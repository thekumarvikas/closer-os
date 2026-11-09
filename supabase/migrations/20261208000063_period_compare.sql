-- Comparison report: one period's totals, uniques and the counts behind averages and percentages,
-- for the whole team and per team member. The dashboard / app call it for a period and the one before.
create or replace function public.period_summary(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' set work_mem = '24MB' as $$
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
    select c.user_id, c.phone, c.lead_id, c.direction, c.duration_sec,
      (c.started_at at time zone v_tz)::date as day,
      c.direction in ('incoming', 'outgoing') and c.duration_sec > 0 as talked,
      o.category = 'won' as won,
      case when o.category = 'won' then coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) else 0 end as amount,
      c.direction in ('missed', 'rejected') and not exists (
        select 1 from public.calls r where r.org_id = p_org and r.phone = c.phone and r.started_at > c.started_at
          and (r.direction = 'outgoing' or (r.direction = 'incoming' and r.duration_sec > 0))) as never_attended
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to and c.user_id = any(v_users)
  ),
  ca as (
    select grouping(user_id) as g, user_id,
      count(*) as calls,
      count(*) filter (where direction = 'outgoing') as dialled,
      count(*) filter (where direction = 'outgoing' and duration_sec > 0) as picked,
      count(*) filter (where direction = 'outgoing' and duration_sec = 0) as not_picked,
      count(*) filter (where direction = 'incoming') as received,
      count(*) filter (where direction in ('missed', 'rejected')) as missed,
      count(*) filter (where never_attended) as never_attended,
      count(*) filter (where talked) as conversations,
      coalesce(sum(duration_sec) filter (where talked), 0) as talk_sec,
      count(distinct phone) as uniq_numbers,
      count(distinct phone) filter (where talked) as uniq_reached,
      count(distinct lead_id) filter (where talked) as leads_reached,
      count(distinct lead_id) filter (where direction = 'outgoing') as leads_dialled,
      count(distinct day) as active_days,
      count(*) filter (where won) as sales,
      coalesce(sum(amount), 0) as revenue
    from c group by grouping sets ((), (user_id))
  ),
  l as (
    select grouping(assigned_to) as g, assigned_to as user_id,
      count(*) filter (where assigned_at >= p_from and assigned_at < p_to) as assigned,
      count(*) filter (where assigned_at >= p_from and assigned_at < p_to and dial_count > 0) as assigned_called,
      count(*) filter (where first_dialled_at >= p_from and first_dialled_at < p_to) as new_called,
      percentile_cont(0.5) within group (order by response_sec) filter (where first_dialled_at >= p_from and first_dialled_at < p_to and is_live and response_sec is not null) as response_median_sec
    from public.leads
    where org_id = p_org and deleted_at is null and assigned_to = any(v_users)
      and ((assigned_at >= p_from and assigned_at < p_to) or (first_dialled_at >= p_from and first_dialled_at < p_to))
    group by grouping sets ((), (assigned_to))
  ),
  f as (
    select grouping(assigned_to) as g, assigned_to as user_id,
      count(*) as fu_due,
      count(*) filter (where dialled_at is not null and dialled_at <= due_at + interval '15 minutes') as fu_on_time,
      count(*) filter (where dialled_at is not null and dialled_at > due_at + interval '15 minutes') as fu_late
    from public.follow_ups
    where org_id = p_org and due_at >= p_from and due_at < least(p_to, now() - interval '15 minutes')
      and status <> 'cancelled' and assigned_to = any(v_users)
    group by grouping sets ((), (assigned_to))
  ),
  allrows as (
    select coalesce(ca.g, l.g, f.g) as g, coalesce(ca.user_id, l.user_id, f.user_id) as user_id,
      to_jsonb(ca) - 'g' - 'user_id' as a, to_jsonb(l) - 'g' - 'user_id' as b, to_jsonb(f) - 'g' - 'user_id' as d
    from ca full join l on l.g = ca.g and l.user_id is not distinct from ca.user_id
            full join f on f.g = coalesce(ca.g, l.g) and f.user_id is not distinct from coalesce(ca.user_id, l.user_id)
  )
  select jsonb_build_object(
    'total', coalesce((select coalesce(a, '{}') || coalesce(b, '{}') || coalesce(d, '{}') from allrows where g = 1), '{}'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id) || coalesce(a, '{}') || coalesce(b, '{}') || coalesce(d, '{}'))
                        from allrows where g = 0 and user_id is not null), '[]'::jsonb)
  ) into res;
  return res;
end $$;
grant execute on function public.period_summary(uuid, timestamptz, timestamptz, uuid[]) to authenticated;
