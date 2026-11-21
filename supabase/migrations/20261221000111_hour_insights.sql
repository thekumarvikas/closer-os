-- Reports → By hour: the insights box under the table (owner, Nov 21 2026).
-- Same filters as call_report. Positive = outcome category positive|won. Conversation = talk > 0.
create or replace function public.hour_insights(p_org uuid, p_from timestamptz, p_to timestamptz,
  p_users uuid[] default null, p_dirs text[] default null, p_channels text[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' set work_mem = '24MB' as $$
declare v_tz text; v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then
    v_users := array(select unnest(v_users) intersect select unnest(p_users));
  end if;

  with c as (
    select c.id, c.user_id, c.phone, c.direction::text dir, c.duration_sec, c.started_at, c.from_history,
      c.outcome_id, o.label, o.code, o.category,
      (c.started_at at time zone v_tz)::date as day, extract(hour from c.started_at at time zone v_tz)::int as hr
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to and c.user_id = any(v_users)
      and (p_dirs is null or c.direction::text = any(p_dirs)) and (p_channels is null or c.channel = any(p_channels))
  ), h90 as (
    select c.user_id, extract(hour from c.started_at at time zone v_tz)::int hr,
      count(*) filter (where c.direction in ('incoming','outgoing') and c.duration_sec > 0) conn,
      coalesce(sum(c.duration_sec) filter (where c.direction in ('incoming','outgoing') and c.duration_sec > 0), 0) talk,
      count(*) filter (where o.category in ('positive','won')) pos
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.started_at >= now() - interval '90 days' and c.user_id = any(v_users)
      and (p_channels is null or c.channel = any(p_channels))
    group by 1, 2
  )
  select jsonb_build_object(
    'hours', coalesce((select jsonb_agg(jsonb_build_object('hr', hr, 'pos', pos, 'won', won, 'no_outcome', nooc) order by hr) from (
        select hr, count(*) filter (where category in ('positive','won')) pos, count(*) filter (where category = 'won') won,
          count(*) filter (where outcome_id is null and not coalesce(from_history, false) and (dir = 'outgoing' or (dir = 'incoming' and duration_sec > 0))) nooc
        from c group by hr) x), '[]'),
    'outcomes', coalesce((select jsonb_agg(jsonb_build_object('id', outcome_id, 'label', label, 'code', code, 'category', category, 'hr', hr, 'n', n, 'total', total) order by total desc)
      from (select distinct on (outcome_id) outcome_id, label, code, category, hr, n, total from (
          select outcome_id, label, code, category, hr, count(*) n, sum(count(*)) over (partition by outcome_id) total
          from c where outcome_id is not null group by 1,2,3,4,5) y order by outcome_id, n desc, hr) z), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'hr', hr, 'conn', conn, 'talk', talk, 'pos', pos)) from (
        select day, hr, count(*) filter (where dir in ('incoming','outgoing') and duration_sec > 0) conn,
          coalesce(sum(duration_sec) filter (where dir in ('incoming','outgoing') and duration_sec > 0), 0) talk,
          count(*) filter (where category in ('positive','won')) pos
        from c group by 1, 2) d), '[]'),
    'last_call', (select max(started_at) from c),
    'missed', (select count(*) from c where dir in ('missed','rejected')),
    'missed_open', (select count(distinct m.phone) from c m where m.dir in ('missed','rejected') and coalesce(m.phone,'') <> '' and not exists (
        select 1 from public.calls r where r.org_id = p_org and public.phone_key(r.phone) = public.phone_key(m.phone) and r.started_at > m.started_at
          and (r.direction = 'outgoing' or (r.direction = 'incoming' and r.duration_sec > 0)))),
    'team90', coalesce((select jsonb_agg(jsonb_build_object('hr', hr, 'conn', conn, 'talk', talk, 'pos', pos)) from (
        select hr, sum(conn) conn, sum(talk) talk, sum(pos) pos from h90 group by hr) t), '[]'),
    'users90', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'hr', hr, 'conn', conn, 'talk', talk, 'pos', pos)) from h90), '[]')
  ) into res;
  return res;
end $$;
grant execute on function public.hour_insights(uuid, timestamptz, timestamptz, uuid[], text[], text[]) to authenticated;
