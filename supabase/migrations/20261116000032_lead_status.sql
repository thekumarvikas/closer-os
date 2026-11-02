-- Outcomes measured against ALL leads (not only calls): for the chosen people, how many leads they
-- have, how many were called, reached, and where each lead stands now (its latest outcome).
-- p_from / p_to (optional) limit to leads ASSIGNED in that period (e.g. "this month's leads").
create or replace function public.lead_status_report(p_org uuid, p_users uuid[] default null, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  with l as (
    select l.id, l.assigned_to, l.last_outcome_id, l.last_call_at, l.last_connected_at, o.category
    from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
    where l.org_id = p_org and l.deleted_at is null and l.assigned_to = any(v_users)
      and (p_from is null or l.assigned_at >= p_from) and (p_to is null or l.assigned_at < p_to)
  ), per_rep as (
    select assigned_to, count(*) total, count(*) filter (where last_call_at is not null) called,
      count(*) filter (where last_connected_at is not null) reached,
      count(*) filter (where category = 'positive') interested, count(*) filter (where category = 'won') won,
      count(*) filter (where category in ('lost', 'invalid')) lost
    from l group by assigned_to
  )
  select jsonb_build_object(
    'total', (select count(*) from l),
    'never_called', (select count(*) from l where last_call_at is null),
    'called', (select count(*) from l where last_call_at is not null),
    'reached', (select count(*) from l where last_connected_at is not null),
    'by_outcome', (select coalesce(jsonb_agg(jsonb_build_object('outcome_id', last_outcome_id, 'leads', n) order by n desc), '[]')
                   from (select last_outcome_id, count(*) n from l where last_outcome_id is not null group by 1) s),
    'by_category', (select coalesce(jsonb_object_agg(category, n), '{}') from (select category, count(*) n from l where category is not null group by 1) s),
    'by_rep', (select coalesce(jsonb_agg(to_jsonb(per_rep) order by won desc, interested desc), '[]') from per_rep)
  ) into res;
  return res;
end $$;
revoke execute on function public.lead_status_report(uuid, uuid[], timestamptz, timestamptz) from anon, public;
grant execute on function public.lead_status_report(uuid, uuid[], timestamptz, timestamptz) to authenticated;
