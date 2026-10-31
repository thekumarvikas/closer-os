-- Outcome report: what happened on calls (Interested, Sale Closed, No Answer…), by rep and by day.
-- Only calls to leads count, because outcomes are only recorded for lead calls.
-- "Not filled" = lead calls without an outcome yet.

create or replace function public.outcome_report(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null
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
    select c.user_id, c.lead_id, c.outcome_id, c.duration_sec,
      (c.started_at at time zone v_tz)::date as day,
      coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) as amount,
      coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) as deal_value
    from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
      and c.user_id = any(v_users) and c.lead_id is not null
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
end $$;

revoke execute on function public.outcome_report(uuid, timestamptz, timestamptz, uuid[]) from anon, public;
grant execute on function public.outcome_report(uuid, timestamptz, timestamptz, uuid[]) to authenticated;
