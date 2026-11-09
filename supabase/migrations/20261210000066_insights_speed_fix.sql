-- Insights → speed to first call: only leads that came in by themselves (leads added from a phone
-- call had their first call BEFORE they were created → negative minutes), in working minutes, never < 0.
create or replace function public.conversion_insights(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  if not public.is_org_manager(p_org) then raise exception 'Managers only'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  return (with l as (
      select l.*, pc.name cat, (select max(watch_minutes) from public.batch_leads b where b.lead_id = l.id) watch,
        -- Only leads that came in by themselves (not added from a call, not bulk imports), in working minutes.
        (l.is_live and coalesce(l.source, '') <> 'Phone call') live,
        case when l.first_dialled_at is null then null
             else greatest(0, coalesce(l.response_sec, extract(epoch from (l.first_dialled_at - l.created_at))::int)) / 60.0 end first_min
      from public.leads l left join public.profession_categories pc on pc.id = l.profession_category_id
      where l.org_id = p_org and l.deleted_at is null
        and l.created_at >= (p_from::timestamp at time zone v_tz) and l.created_at < ((p_to + 1)::timestamp at time zone v_tz)
    ), g as (
      select 'source' dim, coalesce(nullif(source, ''), '—') k, * from l
      union all select 'category', coalesce(cat, 'No group'), * from l
      union all select 'watch', case when watch is null then 'No webinar' when watch = 0 then 'Did not join' when watch < 30 then '1–29 min' when watch < 60 then '30–59 min' else '60+ min' end, * from l
      union all select 'city', coalesce(nullif(city, ''), '—'), * from l
      union all select 'speed', case when first_min is null then 'Never called' when first_min <= 5 then 'Within 5 min' when first_min <= 60 then '5–60 min'
                                     when first_min <= 1440 then '1–24 hours' else 'After a day' end, * from l where live
    )
    select jsonb_build_object(
      'groups', (select coalesce(jsonb_agg(jsonb_build_object('dim', dim, 'key', k, 'leads', n, 'won', w, 'rate', r, 'talk_min_won', t) order by dim, n desc), '[]')
        from (select dim, k, count(*) n, count(*) filter (where won_at is not null) w,
                     round(100.0 * count(*) filter (where won_at is not null) / nullif(count(*), 0), 1) r,
                     round(avg(total_talk_sec / 60.0) filter (where won_at is not null), 1) t
              from g group by dim, k) x),
      'speed_by_rep', (select coalesce(jsonb_agg(jsonb_build_object('user_id', assigned_to, 'name', coalesce(p.full_name, p.email),
            'avg_min', a, 'median_min', m, 'never', nv, 'leads', n) order by a nulls last), '[]')
        from (select assigned_to, count(*) n, round(avg(first_min)) a, round(percentile_cont(0.5) within group (order by first_min)) m,
                     count(*) filter (where first_min is null) nv
              from l where assigned_to is not null and live group by assigned_to) y left join public.profiles p on p.id = y.assigned_to)
    ));
end $$;

