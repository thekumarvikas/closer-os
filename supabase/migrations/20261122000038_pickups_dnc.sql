-- A "real pickup": a call our team DIALLED to the lead where the person actually talked.
-- Uses the rep's outcome when there is one (connected / positive / won / lost = talked;
-- not_connected / invalid = no), otherwise talk time of 20 s or more (operator messages such as
-- "switched off" connect for a few seconds and must not count). Any of the lead's numbers counts.
create or replace function public.is_real_pickup(p_direction public.call_direction, p_duration int, p_category public.outcome_category)
returns boolean language sql immutable as $$
  select p_direction = 'outgoing' and case
    when p_category is not null then p_category in ('connected', 'positive', 'won', 'lost')
    else coalesce(p_duration, 0) >= 20 end
$$;

create or replace function public.best_time_to_call(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_tz text; r record; v_total int; v_picked int;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select l.org_id, o.timezone into v_org, v_tz from public.leads l join public.organizations o on o.id = l.org_id where l.id = p_lead;

  select count(*) filter (where c.direction = 'outgoing'),
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, co.category))
    into v_total, v_picked
  from public.calls c left join public.call_outcomes co on co.id = c.outcome_id
  where c.lead_id = p_lead;

  -- This person's own pattern: the hour they picked up most, at least twice.
  select extract(hour from c.started_at at time zone v_tz)::int hr,
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, co.category)) ok,
         count(*) filter (where c.direction = 'outgoing') n into r
  from public.calls c left join public.call_outcomes co on co.id = c.outcome_id
  where c.lead_id = p_lead
  group by 1 having count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, co.category)) >= 2
  order by 2 desc, 3 asc limit 1;
  if r.hr is not null then
    return jsonb_build_object('hour', r.hr, 'source', 'lead', 'picked', r.ok, 'tries', r.n, 'total_picked', v_picked, 'total_tries', v_total);
  end if;

  -- Otherwise the team's best pick-up hour (last 30 days, at least 20 dialled calls in that hour).
  select extract(hour from c.started_at at time zone v_tz)::int hr,
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, co.category)) ok, count(*) n into r
  from public.calls c left join public.call_outcomes co on co.id = c.outcome_id
  where c.org_id = v_org and c.direction = 'outgoing' and c.started_at > now() - interval '30 days'
  group by 1 having count(*) >= 20
  order by count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, co.category))::numeric / count(*) desc limit 1;
  if r.hr is null then
    return case when v_total > 0 then jsonb_build_object('source', 'none', 'total_picked', v_picked, 'total_tries', v_total) else null end;
  end if;
  return jsonb_build_object('hour', r.hr, 'source', 'team', 'rate', round(r.ok * 100.0 / r.n), 'total_picked', v_picked, 'total_tries', v_total);
end $$;

-- Remove / set "Do not call" from the app — anyone who can see the lead; always audit-logged.
create or replace function public.set_do_not_call(p_lead uuid, p_value boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  update public.leads set do_not_call = p_value where id = p_lead returning org_id into v_org;
  perform public.write_audit(v_org, case when p_value then 'lead_dnc_set' else 'lead_dnc_removed' end, 'lead', p_lead::text, '{}'::jsonb);
end $$;
grant execute on function public.set_do_not_call(uuid, boolean) to authenticated;
