-- Revenue in Sales insights: each lead's sale amount (amount saved with "Sale closed" outcomes; else the
-- lead's deal value once won), shown per group (Who buys) and per person / per sale (What it takes).
create or replace function public.lead_revenue(p_lead uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select sum(coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0))
       from public.calls c join public.call_outcomes o on o.id = c.outcome_id
      where c.lead_id = p_lead and o.category = 'won'
      having sum(coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0)) > 0),
    (select l.deal_value from public.leads l where l.id = p_lead and l.won_at is not null), 0);
$$;
revoke all on function public.lead_revenue(uuid) from public, anon;

create or replace function public.conversion_insights(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  if not public.is_org_manager(p_org) then raise exception 'Managers only'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  return (with l as (
      select l.*, pc.name cat, public.lead_revenue(l.id) rev, (select max(watch_minutes) from public.batch_leads b where b.lead_id = l.id) watch,
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
      'revenue', (select coalesce(sum(rev), 0) from l),
      'leads', (select count(*) from l), 'won', (select count(*) from l where won_at is not null),
      'groups', (select coalesce(jsonb_agg(jsonb_build_object('dim', dim, 'key', k, 'leads', n, 'won', w, 'rate', r, 'talk_min_won', t,
                    'revenue', rv, 'avg_sale', round(rv / nullif(w, 0)), 'rev_per_lead', round(rv / nullif(n, 0))) order by dim, n desc), '[]')
        from (select dim, k, count(*) n, count(*) filter (where won_at is not null) w, coalesce(sum(rev), 0) rv,
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


create or replace function public.sales_recipe(p_org uuid, p_users uuid[] default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_from timestamptz; v_to timestamptz;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  v_from := coalesce(p_from, date '2000-01-01')::timestamp at time zone v_tz;
  v_to := (coalesce(p_to, current_date) + 1)::timestamp at time zone v_tz;
  return (with won as (
      select l.id, l.name, l.phone, l.assigned_to, l.won_at, public.lead_effort(l.id) e, public.lead_revenue(l.id) rev
      from public.leads l where l.org_id = p_org and l.deleted_at is null and l.won_at >= v_from and l.won_at < v_to
    ), avgs as (
      select (assigned_to = any(v_users)) mine, count(*) n,
        round(avg((e->>'talk_min')::numeric), 1) talk_min, round(avg((e->>'calls')::numeric), 1) calls,
        round(avg((e->>'picked')::numeric), 1) picked, round(avg((e->>'wa')::numeric), 1) wa,
        round(avg((e->>'follow_ups')::numeric), 1) follow_ups, round(avg((e->>'days')::numeric), 1) days,
        round(avg((e->>'calls')::numeric + (e->>'received')::numeric + (e->>'wa')::numeric), 1) interactions,
        round(sum(rev)) revenue, round(avg(rev)) avg_sale,
        round(sum(rev) / nullif(sum((e->>'talk_min')::numeric) / 60, 0)) rev_per_talk_hour
      from won group by rollup ((assigned_to = any(v_users)))
    )
    select jsonb_build_object(
      'mine', (select to_jsonb(a) - 'mine' from avgs a where a.mine is true),
      'team', (select to_jsonb(a) - 'mine' from avgs a where a.mine is null),
      'leads', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'won_at', won_at, 'effort', e, 'revenue', rev) order by won_at desc), '[]')
                from won where assigned_to = any(v_users)),
      'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', assigned_to, 'name', coalesce(p.full_name, p.email), 'sales', n,
                   'talk_min', t, 'calls', c, 'wa', wa, 'days', d, 'follow_ups', fu, 'revenue', rv, 'avg_sale', round(rv / nullif(n, 0)),
                   'rev_per_talk_hour', round(rv / nullif(tt / 60, 0))) order by rv desc, n desc), '[]') from (
                   select assigned_to, count(*) n, round(avg((e->>'talk_min')::numeric), 1) t, round(avg((e->>'calls')::numeric), 1) c,
                          round(avg((e->>'wa')::numeric), 1) wa, round(avg((e->>'days')::numeric), 1) d, round(avg((e->>'follow_ups')::numeric), 1) fu,
                          coalesce(sum(rev), 0) rv, sum((e->>'talk_min')::numeric) tt
                   from won where assigned_to = any(v_users) group by assigned_to) x left join public.profiles p on p.id = x.assigned_to)
    ));
end $$;

