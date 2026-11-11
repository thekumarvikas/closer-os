-- App/dashboard calls run with "safe update" on: a DELETE must have a WHERE. Same function, one line changed.
create or replace function public.efficiency_report(p_org uuid, p_from date, p_to date, p_users uuid[] default null)
returns jsonb language plpgsql volatile security definer set search_path = '' set work_mem = '24MB' as $$
declare
  s jsonb; v_tz text; t0 timestamptz; t1 timestamptz; v_all uuid[]; u uuid; d date; wd jsonb;
  people jsonb := '[]'; v_days jsonb; agg jsonb; m record; tgt int; team record;
  v_time numeric; v_calling numeric; v_conv numeric; v_disc numeric; v_overall numeric; parts numeric[]; wts numeric[];
  late_score numeric; n_days int; n_pressed int; tot jsonb; v_vis uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to < p_from then raise exception 'The end date must be after the start date'; end if;
  if p_to - p_from > 62 then raise exception 'Choose a period of at most 2 months'; end if;
  s := public.efficiency_settings(p_org); v_tz := s->>'tz';
  t0 := (p_from::timestamp) at time zone v_tz; t1 := ((p_to + 1)::timestamp) at time zone v_tz;
  -- Team comparisons use the whole company; only people this user may see are returned.
  v_all := array(select user_id from public.org_members where org_id = p_org);
  v_vis := public.visible_user_ids(p_org);

  -- Call / follow-up / lead numbers per person.
  create temp table if not exists _eff (user_id uuid primary key, dials int, conversations int, lead_calls int, with_outcome int,
    outcome_fast int, positive int, sales int, fu_due int, fu_on_time int, unique_leads int, new_leads int, new_connected int,
    fu_leads int, fu_connected int, days jsonb, days_n int, target_calls int) on commit drop;
  delete from _eff where true;
  insert into _eff (user_id, dials, conversations, lead_calls, with_outcome, outcome_fast, positive, sales, unique_leads)
  select c.user_id,
    count(*) filter (where c.direction = 'outgoing'),
    count(*) filter (where c.duration_sec > 0 and c.direction in ('outgoing', 'incoming')),
    count(*) filter (where c.lead_id is not null and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.duration_sec > 0))),
    count(*) filter (where c.lead_id is not null and c.outcome_id is not null and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.duration_sec > 0))),
    count(*) filter (where c.lead_id is not null and c.outcome_at is not null and c.outcome_at <= c.started_at + make_interval(secs => c.duration_sec) + interval '10 minutes'),
    count(*) filter (where o.category in ('positive', 'won') and c.duration_sec > 0),
    count(*) filter (where o.category = 'won'),
    count(distinct c.lead_id)
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.org_id = p_org and c.started_at >= t0 and c.started_at < t1 and c.user_id = any(v_all)
  group by c.user_id;
  insert into _eff (user_id) select x from unnest(v_all) x
    where exists (select 1 from public.work_events e where e.org_id = p_org and e.user_id = x and e.at >= t0 and e.at < t1)
  on conflict do nothing;

  update _eff e set fu_due = f.due, fu_on_time = f.on_time, fu_leads = f.leads, fu_connected = f.connected
  from (select f.assigned_to, count(*) as due,
          count(*) filter (where f.dialled_at is not null and f.dialled_at <= f.due_at + interval '15 minutes') as on_time,
          count(distinct f.lead_id) as leads,
          count(distinct f.lead_id) filter (where exists (select 1 from public.calls c where c.lead_id = f.lead_id and c.user_id = f.assigned_to
             and c.duration_sec > 0 and c.started_at between f.due_at - interval '10 minutes' and f.due_at + interval '1 day')) as connected
        from public.follow_ups f
        where f.org_id = p_org and f.due_at >= t0 and f.due_at < least(t1, now() - interval '15 minutes') and f.status <> 'cancelled'
        group by f.assigned_to) f
  where f.assigned_to = e.user_id;
  update _eff e set new_leads = l.n, new_connected = l.c
  from (select l.assigned_to, count(*) as n,
          count(*) filter (where exists (select 1 from public.calls c where c.lead_id = l.id and c.duration_sec > 0 and c.started_at >= t0 and c.started_at < t1)) as c
        from public.leads l where l.org_id = p_org and l.deleted_at is null and l.first_dialled_at >= t0 and l.first_dialled_at < t1
        group by l.assigned_to) l
  where l.assigned_to = e.user_id;
  update _eff e set target_calls = coalesce(
    (select calls from public.rep_targets r where r.org_id = p_org and r.user_id = e.user_id),
    (select calls from public.rep_targets r where r.org_id = p_org and r.user_id is null));

  -- Working days: any day with calls, WhatsApp, app use or Start day.
  for u in select user_id from _eff loop
    v_days := '[]';
    -- People not shown only need their number of working days (for team averages): cheap count.
    if not (u = any(v_vis) and (p_users is null or cardinality(p_users) = 0 or u = any(p_users))) then
      update _eff set days_n = (select count(distinct (started_at at time zone v_tz)::date) from public.calls
        where org_id = p_org and user_id = u and started_at >= t0 and started_at < t1) where user_id = u;
      continue;
    end if;
    for d in select distinct (x at time zone v_tz)::date from (
        select started_at x from public.calls where org_id = p_org and user_id = u and started_at >= t0 and started_at < t1
        union all select at from public.work_events where org_id = p_org and user_id = u and at >= t0 and at < t1
        union all select sent_at from public.wa_messages where org_id = p_org and user_id = u and sent_at >= t0 and sent_at < t1
        union all select started_at from public.activity_segments where org_id = p_org and user_id = u and started_at >= t0 and started_at < t1) q
      order by 1 loop
      wd := public.work_day(p_org, u, d);
      if coalesce((wd->>'worked')::boolean, false) then v_days := v_days || jsonb_build_array(wd); end if;
    end loop;
    update _eff set days = v_days, days_n = jsonb_array_length(v_days) where user_id = u;
  end loop;

  -- Team averages (per working day) for fair comparisons.
  select avg(dials::numeric / nullif(days_n, 0)) as dials_day,
         sum(positive)::numeric / nullif(sum(conversations), 0) as pos_rate,
         sum(sales)::numeric / nullif(sum(conversations), 0) as sale_rate
    into team from _eff where coalesce(days_n, 0) > 0;

  for m in select * from _eff where user_id = any(v_vis) and (p_users is null or cardinality(p_users) = 0 or user_id = any(p_users)) loop
    n_days := jsonb_array_length(coalesce(m.days, '[]'));
    select jsonb_object_agg(k, v) into agg from (
      select k, sum((x->>k)::numeric)::int as v from jsonb_array_elements(coalesce(m.days, '[]')) x,
        unnest(array['window', 'calling', 'talk', 'wa', 'wa_msgs', 'crm', 'app', 'between', 'idle', 'break']) k group by k) z;
    agg := coalesce(agg, '{}');
    select count(*) filter (where (x->>'pressed_start')::boolean),
           avg(case when (x->>'late_min') is null then null when (x->>'late_min')::int <= 5 then 100
                    when (x->>'late_min')::int >= 60 then 0 else 100 - ((x->>'late_min')::int - 5) * 100.0 / 55 end)
      into n_pressed, late_score from jsonb_array_elements(coalesce(m.days, '[]')) x;

    -- 1) Time: productive share of the working day (breaks left out).
    v_time := case when coalesce((agg->>'window')::numeric, 0) - coalesce((agg->>'break')::numeric, 0) > 0
      then least(100, 100 * ((agg->>'window')::numeric - (agg->>'idle')::numeric - (agg->>'break')::numeric)
                       / ((agg->>'window')::numeric - (agg->>'break')::numeric)) end;
    -- 2) Calling: dials vs target (or team average) 40 · follow-ups on time 30 · outcomes filled 30.
    parts := array[
      case when n_days = 0 then null when coalesce(m.target_calls, 0) > 0 then least(100, 100.0 * coalesce(m.dials, 0) / (m.target_calls * n_days))
           when coalesce(team.dials_day, 0) > 0 then least(100, 100.0 * coalesce(m.dials, 0) / n_days / team.dials_day) end,
      case when coalesce(m.fu_due, 0) > 0 then 100.0 * m.fu_on_time / m.fu_due end,
      case when coalesce(m.lead_calls, 0) > 0 then 100.0 * m.with_outcome / m.lead_calls end];
    wts := array[40, 30, 30];
    v_calling := (select sum(p * w) / nullif(sum(w), 0) from unnest(parts, wts) as t(p, w) where p is not null);
    -- 3) Conversion: interested/won per conversation vs team · sales per conversation vs team.
    parts := array[
      case when coalesce(m.conversations, 0) > 0 and coalesce(team.pos_rate, 0) > 0 then least(100, 100.0 * m.positive / m.conversations / team.pos_rate) end,
      case when coalesce(m.conversations, 0) > 0 and coalesce(team.sale_rate, 0) > 0 then least(100, 100.0 * m.sales / m.conversations / team.sale_rate) end];
    v_conv := (select avg(p) from unnest(parts) p where p is not null);
    -- 4) Discipline: on time at start · breaks within allowance · outcomes saved within 10 min · Start day used.
    parts := array[
      late_score,
      case when n_days = 0 then null when coalesce((agg->>'break')::numeric, 0) <= (s->>'break_min')::int * 60 * n_days then 100
           else 100.0 * (s->>'break_min')::int * 60 * n_days / (agg->>'break')::numeric end,
      case when coalesce(m.lead_calls, 0) > 0 then 100.0 * m.outcome_fast / m.lead_calls end,
      case when n_days > 0 then 100.0 * n_pressed / n_days end];
    v_disc := (select avg(p) from unnest(parts) p where p is not null);
    parts := array[v_time, v_calling, v_conv, v_disc];
    wts := array[(s->>'w_time')::numeric, (s->>'w_calling')::numeric, (s->>'w_conversion')::numeric, (s->>'w_discipline')::numeric];
    v_overall := (select sum(p * w) / nullif(sum(w), 0) from unnest(parts, wts) as t(p, w) where p is not null);

    people := people || jsonb_build_array(jsonb_build_object(
      'user_id', m.user_id, 'days_worked', n_days, 'days_started', n_pressed, 'time', agg,
      'productive', coalesce((agg->>'window')::int, 0) - coalesce((agg->>'idle')::int, 0) - coalesce((agg->>'break')::int, 0),
      'scores', jsonb_build_object('time', round(v_time), 'calling', round(v_calling), 'conversion', round(v_conv),
                                   'discipline', round(v_disc), 'overall', round(v_overall)),
      'detail', jsonb_build_object('dials', coalesce(m.dials, 0), 'target_calls', m.target_calls, 'conversations', coalesce(m.conversations, 0),
        'lead_calls', coalesce(m.lead_calls, 0), 'with_outcome', coalesce(m.with_outcome, 0), 'outcome_fast', coalesce(m.outcome_fast, 0),
        'positive', coalesce(m.positive, 0), 'sales', coalesce(m.sales, 0), 'fu_due', coalesce(m.fu_due, 0), 'fu_on_time', coalesce(m.fu_on_time, 0),
        'avg_late_min', (select round(avg((x->>'late_min')::numeric)) from jsonb_array_elements(coalesce(m.days, '[]')) x)),
      'leads', jsonb_build_object('unique', coalesce(m.unique_leads, 0), 'new', coalesce(m.new_leads, 0), 'new_connected', coalesce(m.new_connected, 0),
        'followup', coalesce(m.fu_leads, 0), 'followup_connected', coalesce(m.fu_connected, 0)),
      'days', coalesce(m.days, '[]')));
  end loop;
  return jsonb_build_object('settings', s, 'people', people);
end $$;

