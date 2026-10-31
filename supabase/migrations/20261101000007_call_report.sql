-- Call reports (Callyzer-style): totals, per rep, per day, per hour, with a "lead calls" split.
-- Runs inside the database so it stays fast with hundreds of thousands of calls.
--
-- Definitions (shown to users as tooltips):
--   connected        incoming/outgoing call with talk time > 0
--   not picked       outgoing call with 0 talk time (customer did not answer)
--   never attended   missed/rejected call that was never returned (no later outgoing call, or
--                    connected incoming call, with that number)
--   unique clients   distinct phone numbers
--   working time     per rep per day: first call start → last call end
--   idle time        working time minus talk time

create index if not exists calls_org_phone_time_idx on public.calls (org_id, phone, started_at);

-- People whose calls the signed-in user may see in a company.
create or replace function public.visible_user_ids(p_org uuid)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare v uuid[];
begin
  if public.is_org_admin(p_org) then
    select array_agg(user_id) into v from public.org_members where org_id = p_org;
  elsif public.org_role(p_org) = 'manager' then
    select array_agg(distinct u) into v from (
      select auth.uid() as u
      union
      select theirs.user_id
      from public.team_members mine
      join public.team_members theirs on theirs.team_id = mine.team_id
      where mine.user_id = auth.uid() and mine.is_manager and mine.org_id = p_org
    ) x;
  elsif public.org_role(p_org) is not null then
    v := array[auth.uid()];
  end if;
  return coalesce(v, '{}');
end $$;

create or replace function public.call_report(
  p_org uuid, p_from timestamptz, p_to timestamptz,
  p_users uuid[] default null, p_lead_only boolean default false
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
    select
      c.id, c.user_id, c.phone, c.direction, c.duration_sec, c.started_at,
      c.lead_id is not null as is_lead,
      c.direction in ('incoming', 'outgoing') and c.duration_sec > 0 as connected,
      (c.started_at at time zone v_tz)::date as day,
      extract(hour from c.started_at at time zone v_tz)::int as hr,
      c.direction in ('missed', 'rejected') and not exists (
        select 1 from public.calls r
        where r.org_id = p_org and r.phone = c.phone and r.started_at > c.started_at
          and (r.direction = 'outgoing' or (r.direction = 'incoming' and r.duration_sec > 0))
      ) as never_attended
    from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
      and c.user_id = any(v_users)
      and (not p_lead_only or c.lead_id is not null)
  ),
  agg as (
    select
      grouping(user_id, day, hr, is_lead) as g, user_id, day, hr, is_lead,
      count(*) as calls,
      coalesce(sum(duration_sec), 0) as dur,
      count(*) filter (where direction = 'incoming') as inc,
      coalesce(sum(duration_sec) filter (where direction = 'incoming'), 0) as inc_dur,
      count(*) filter (where direction = 'incoming' and duration_sec > 0) as inc_conn,
      count(*) filter (where direction = 'outgoing') as out,
      coalesce(sum(duration_sec) filter (where direction = 'outgoing'), 0) as out_dur,
      count(*) filter (where direction = 'outgoing' and duration_sec > 0) as out_conn,
      count(*) filter (where direction = 'missed') as missed,
      count(*) filter (where direction = 'rejected') as rejected,
      count(*) filter (where connected) as conn,
      coalesce(sum(duration_sec) filter (where connected), 0) as conn_dur,
      count(*) filter (where direction = 'outgoing' and duration_sec = 0) as not_picked,
      count(*) filter (where never_attended) as never_attended,
      count(distinct phone) as uniq,
      count(distinct phone) filter (where connected) as uniq_conn
    from c
    group by grouping sets ((), (is_lead), (user_id), (user_id, is_lead), (day), (day, is_lead),
                            (day, user_id), (day, user_id, is_lead), (hr), (hr, is_lead))
  ),
  work as (
    select user_id, day, is_lead,
      extract(epoch from max(started_at + make_interval(secs => duration_sec)) - min(started_at))::int as work_sec
    from c group by grouping sets ((user_id, day), (user_id, day, is_lead))
  )
  select jsonb_build_object(
    'tz', v_tz,
    'rows', coalesce((select jsonb_agg(to_jsonb(agg)) from agg), '[]'::jsonb),
    'work', coalesce((select jsonb_agg(to_jsonb(work)) from work), '[]'::jsonb)
  ) into res;
  return res;
end $$;

grant execute on function public.visible_user_ids(uuid) to authenticated;
grant execute on function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean) to authenticated;

revoke execute on function public.visible_user_ids(uuid) from anon, public;
revoke execute on function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean) from anon, public;
