-- Round 15 · 6) Webinar reports by group (Everyone · Registered · Joined without registering), show-up by call
-- result (30-second rule), and a lead list behind every number.

-- ───── Facts per lead, limited to one group ─────
CREATE OR REPLACE FUNCTION public.batch_lead_facts(p_batch uuid, p_purpose text, p_scope text)
 RETURNS TABLE(lead_id uuid, rep uuid, name text, phone text, watch_minutes integer, attended boolean, is_hot boolean, is_repeat boolean, attempts integer, max_dur integer, last_outcome_id uuid, guided boolean, profession_marked boolean, profession_category_id uuid, won boolean, revenue numeric, prev_enrolled boolean, new_enrolled boolean, registered boolean, prev_at timestamp with time zone, prev_minutes numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid; v_hot int; v_at timestamptz; v_users uuid[];
begin
  select org_id, hot_minutes, webinar_at into v_org, v_hot, v_at from public.batches where id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  if p_purpose not in ('sales', 'reminder') then raise exception 'Unknown report type'; end if;
  v_users := public.visible_user_ids(v_org);

  return query
  with bl as (
    select b.lead_id, b.watch_minutes, b.attended, b.is_repeat, b.registered, b.prev_at, b.prev_minutes, l.name, l.phone, l.email,
      l.profession, l.profession_category_id,
      case when p_purpose = 'reminder' then coalesce(b.reminder_by, l.assigned_to) else l.assigned_to end as rep
    from public.batch_leads b
    join public.leads l on l.id = b.lead_id and l.deleted_at is null
    where b.batch_id = p_batch and (coalesce(p_scope, 'all') = 'all' or (p_scope = 'registered') = b.registered)
  ),
  vis as (
    select * from bl where (bl.rep is null and public.is_org_manager(v_org)) or bl.rep = any(v_users)
  ),
  c as (
    select k.lead_id, count(*)::int as attempts, max(k.duration_sec)::int as max_dur,
      bool_or(o.code = 'r_guided') as guided,
      bool_or(o.category = 'won') as won,
      sum(case when o.category = 'won' then coalesce(nullif(regexp_replace(coalesce(k.outcome_data->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) else 0 end) as revenue,
      (array_agg(k.outcome_id order by k.started_at desc) filter (where k.outcome_id is not null))[1] as last_outcome_id
    from public.calls k
    left join public.call_outcomes o on o.id = k.outcome_id
    where k.batch_id = p_batch and k.purpose = p_purpose and k.lead_id in (select vis.lead_id from vis)
    group by k.lead_id
  ),
  -- Guided / won can come from either kind of call: count them for both reports.
  any_call as (
    select k.lead_id, bool_or(o.code = 'r_guided') as guided, bool_or(o.category = 'won') as won
    from public.calls k join public.call_outcomes o on o.id = k.outcome_id
    where k.batch_id = p_batch and k.lead_id in (select vis.lead_id from vis)
    group by k.lead_id
  ),
  buy as (
    select v.lead_id,
      bool_or(cu.purchased_at < v_at) as prev,
      bool_or(cu.purchased_at >= v_at) as new
    from vis v join public.customers cu on cu.org_id = v_org
      and (cu.phone = v.phone or (v.email is not null and lower(cu.email) = v.email))
    group by v.lead_id
  )
  select v.lead_id, v.rep, v.name, v.phone, v.watch_minutes, v.attended,
    coalesce(v.watch_minutes, 0) >= v_hot and v.watch_minutes is not null and v.watch_minutes > 0,
    v.is_repeat,
    coalesce(c.attempts, 0), coalesce(c.max_dur, 0), c.last_outcome_id,
    coalesce(a.guided, false),
    v.profession is not null and v.profession <> '' or v.profession_category_id is not null,
    v.profession_category_id,
    coalesce(a.won, false), coalesce(c.revenue, 0),
    coalesce(buy.prev, false),
    coalesce(buy.new, false) or coalesce(a.won, false),
    v.registered, v.prev_at, v.prev_minutes
  from vis v
  left join c on c.lead_id = v.lead_id
  left join any_call a on a.lead_id = v.lead_id
  left join buy on buy.lead_id = v.lead_id;
end $function$;
revoke execute on function public.batch_lead_facts(uuid, text, text) from anon, public;

create or replace function public.batch_report(p_batch uuid, p_purpose text, p_scope text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with f as (select * from public.batch_lead_facts(p_batch, p_purpose, p_scope)),
  per_rep as (
    select grouping(rep) as g, rep,
      count(*) as assigned,
      count(*) filter (where attended) as attended,
      count(*) filter (where is_hot) as hot,
      count(*) filter (where attempts > 0) as called,
      count(*) filter (where max_dur > 30) as picked,
      count(*) filter (where attempts > 0 and max_dur between 1 and 30) as picked_short,
      count(*) filter (where attempts > 0 and max_dur <= 30) as not_picked,
      count(*) filter (where attempts > 0 and max_dur <= 30 and is_hot) as not_picked_hot,
      count(*) filter (where max_dur > 300) as over5,
      count(*) filter (where max_dur > 300 and is_hot) as over5_hot,
      count(*) filter (where attempts = 0) as left_to_dial,
      count(*) filter (where attempts = 0 and is_hot) as left_to_dial_hot,
      count(*) filter (where guided) as guided,
      count(*) filter (where profession_marked) as professions,
      count(*) filter (where is_repeat) as repeated,
      count(*) filter (where prev_enrolled) as prev_enrolled,
      count(*) filter (where new_enrolled) as new_enrolled,
      count(*) filter (where won) as won,
      count(*) filter (where registered) as registered,
      count(*) filter (where not registered) as walkin,
      coalesce(sum(revenue), 0) as revenue
    from f group by grouping sets ((rep), ())
  ),
  outcomes as (
    select grouping(rep) as g, rep, last_outcome_id as outcome_id, count(*) as leads
    from f where attempts > 0 group by grouping sets ((rep, last_outcome_id), (last_outcome_id))
  ),
  cats as (
    select profession_category_id as category_id, count(*) as leads from f group by profession_category_id
  )
  select jsonb_build_object(
    'reps', coalesce((select jsonb_agg(to_jsonb(per_rep)) from per_rep), '[]'::jsonb),
    'outcomes', coalesce((select jsonb_agg(to_jsonb(outcomes)) from outcomes), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(cats)) from cats), '[]'::jsonb)
  )
$$;
revoke execute on function public.batch_report(uuid, text, text) from anon, public;

-- The leads behind any number on the Reminder / Sales tabs. p_arg: outcome id for 'outcome', category id
-- (or 'none') for 'category'. "Didn't pick" uses the 30-second rule: no call longer than 30 seconds.
create or replace function public.batch_leads_list(p_batch uuid, p_purpose text, p_scope text, p_metric text, p_rep uuid default null, p_arg text default null)
returns table(lead_id uuid, rep uuid, name text, phone text, registered boolean, watch_minutes integer, attempts integer, max_dur integer,
  last_outcome_id uuid, prev_at timestamptz, prev_minutes numeric)
language sql stable security definer set search_path = '' as $$
  select f.lead_id, f.rep, f.name, f.phone, f.registered, f.watch_minutes, f.attempts, f.max_dur, f.last_outcome_id, f.prev_at, f.prev_minutes
  from public.batch_lead_facts(p_batch, p_purpose, p_scope) f
  where (p_rep is null or f.rep is not distinct from nullif(p_rep, '00000000-0000-0000-0000-000000000000'::uuid))
    and case p_metric
      when 'assigned' then true
      when 'attended' then f.attended
      when 'hot' then f.is_hot
      when 'called' then f.attempts > 0
      when 'picked' then f.max_dur > 30
      when 'picked_short' then f.attempts > 0 and f.max_dur between 1 and 30
      when 'not_picked' then f.attempts > 0 and f.max_dur <= 30
      when 'not_picked_hot' then f.attempts > 0 and f.max_dur <= 30 and f.is_hot
      when 'over5' then f.max_dur > 300
      when 'over5_hot' then f.max_dur > 300 and f.is_hot
      when 'left_to_dial' then f.attempts = 0
      when 'left_to_dial_hot' then f.attempts = 0 and f.is_hot
      when 'guided' then f.guided
      when 'not_guided' then not f.guided
      when 'professions' then f.profession_marked
      when 'repeated' then f.is_repeat
      when 'prev_enrolled' then f.prev_enrolled
      when 'new_enrolled' then f.new_enrolled
      when 'won' then f.won
      when 'registered' then f.registered
      when 'walkin' then not f.registered
      when 'outcome' then f.attempts > 0 and f.last_outcome_id::text is not distinct from p_arg
      when 'category' then coalesce(f.profession_category_id::text, 'none') = coalesce(p_arg, 'none')
      else false end
  order by f.watch_minutes desc nulls last, f.name
$$;
revoke execute on function public.batch_leads_list(uuid, text, text, text, uuid, text) from anon, public;

-- ───── Show-up: one row per lead with every bucket the report groups by ─────
create or replace function public.show_up_facts(p_batch uuid, p_scope text default 'all')
returns table(lead_id uuid, name text, phone text, caller uuid, registered boolean, is_holdout boolean, is_repeat boolean,
  prev_at timestamptz, prev_minutes numeric, watch_minutes integer, joined boolean, stayed boolean,
  calls integer, talk integer, longest integer, outcome_id uuid,
  grp text, b_timing text, b_attempts text, b_talk text, b_hour text, b_registered text, b_profession text, b_source text, b_repeat text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_org uuid; v_hot int; v_at timestamptz; v_tz text; v_users uuid[];
begin
  select b.org_id, b.hot_minutes, b.webinar_at, o.timezone into v_org, v_hot, v_at, v_tz
  from public.batches b join public.organizations o on o.id = b.org_id where b.id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(v_org);
  return query
  with f0 as (
    select bl.lead_id as lid, l.name as nm, l.phone as ph, coalesce(bl.reminder_by, l.assigned_to) as cl, bl.registered as reg,
      bl.is_holdout as hold, bl.is_repeat as rep, bl.prev_at as pat, bl.prev_minutes as pmin, bl.added_at as added,
      bl.watch_minutes as wm, coalesce(bl.watch_minutes, 0) > 0 as j,
      coalesce(bl.watch_minutes, 0) >= v_hot and coalesce(bl.watch_minutes, 0) > 0 as st,
      l.profession_category_id as pc, coalesce(nullif(l.source, ''), 'Unknown') as src
    from public.batch_leads bl join public.leads l on l.id = bl.lead_id and l.deleted_at is null
    where bl.batch_id = p_batch and (coalesce(p_scope, 'all') = 'all' or (p_scope = 'registered') = bl.registered)
  ),
  f1 as (select * from f0 where (f0.cl is null and public.is_org_manager(v_org)) or f0.cl = any(v_users)),
  rc as (   -- reminder calls made before the webinar started
    select c.lead_id as lid, count(*)::int as n, coalesce(sum(c.duration_sec), 0)::int as tk, coalesce(max(c.duration_sec), 0)::int as lg,
      max(c.started_at) as last_at, max(c.started_at) filter (where c.duration_sec > 30) as conn_at,
      (array_agg(c.outcome_id order by c.started_at desc) filter (where c.outcome_id is not null))[1] as oc
    from public.calls c
    where c.batch_id = p_batch and c.purpose = 'reminder' and c.started_at < v_at and c.lead_id in (select f1.lid from f1)
    group by c.lead_id
  )
  select f1.lid, f1.nm, f1.ph, f1.cl, f1.reg, f1.hold, f1.rep, f1.pat, f1.pmin, f1.wm, f1.j, f1.st,
    coalesce(rc.n, 0), coalesce(rc.tk, 0), coalesce(rc.lg, 0), rc.oc,
    case when f1.hold then 'holdout' when coalesce(rc.n, 0) = 0 then 'not_dialled' when coalesce(rc.lg, 0) > 30 then 'connected' else 'not_connected' end,
    case when coalesce(rc.n, 0) = 0 then 'z_not_called'
         when v_at - rc.last_at <= interval '3 hours' then 'a_lt3h' when v_at - rc.last_at <= interval '12 hours' then 'b_3_12h'
         when v_at - rc.last_at <= interval '24 hours' then 'c_12_24h' when v_at - rc.last_at <= interval '48 hours' then 'd_1_2d' else 'e_2d_plus' end,
    case when coalesce(rc.n, 0) = 0 then 'a_0' when rc.n = 1 then 'b_1' when rc.n = 2 then 'c_2' else 'd_3plus' end,
    case when coalesce(rc.n, 0) = 0 then 'z_not_called' when coalesce(rc.lg, 0) <= 30 then 'a_never_answered'
         when rc.tk < 60 then 'b_lt1m' when rc.tk < 180 then 'c_1_3m' else 'd_3m_plus' end,
    case when rc.conn_at is null then 'z_no_conversation'
         when extract(hour from rc.conn_at at time zone v_tz) < 12 then 'a_morning' when extract(hour from rc.conn_at at time zone v_tz) < 17 then 'b_afternoon'
         when extract(hour from rc.conn_at at time zone v_tz) < 21 then 'c_evening' else 'd_night' end,
    case when v_at - f1.added <= interval '24 hours' then 'a_lt1d' when v_at - f1.added <= interval '3 days' then 'b_1_3d'
         when v_at - f1.added <= interval '7 days' then 'c_3_7d' else 'd_7d_plus' end,
    coalesce(f1.pc::text, 'z_none'), f1.src,
    case when f1.rep then 'b_repeat' else 'a_new' end
  from f1 left join rc on rc.lid = f1.lid;
end $$;
revoke execute on function public.show_up_facts(uuid, text) from anon, public;

drop function if exists public.show_up_report(uuid);
create or replace function public.show_up_report(p_batch uuid, p_scope text default 'all')
returns jsonb language sql stable security definer set search_path = '' as $$
  with f as (select * from public.show_up_facts(p_batch, p_scope)),
  allf as (select * from public.show_up_facts(p_batch, 'all')),
  -- Patterns compare registrants only: everyone who walked in joined by definition, so they'd only add noise.
  pf as (select * from f where registered and not is_holdout),
  dims as (
    select 'timing' as dim, b_timing as bucket, joined, stayed from pf
    union all select 'attempts', b_attempts, joined, stayed from pf
    union all select 'talk', b_talk, joined, stayed from pf
    union all select 'hour', b_hour, joined, stayed from pf
    union all select 'registered', b_registered, joined, stayed from pf
    union all select 'profession', b_profession, joined, stayed from pf
    -- "Zoom attendee" as a source only says the lead was first seen in the attendance file: always 100%, never an insight.
    union all select 'source', b_source, joined, stayed from pf where b_source <> 'Zoom attendee'
    union all select 'repeat', b_repeat, joined, stayed from pf
  )
  select jsonb_build_object(
    'zoom_uploaded', (select zoom_uploaded_at is not null from public.batches where id = p_batch),
    'scope', coalesce(p_scope, 'all'),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('registered', registered, 'leads', n, 'joined', j, 'stayed', s)), '[]'::jsonb)
               from (select registered, count(*) n, count(*) filter (where joined) j, count(*) filter (where stayed) s from allf group by registered) x),
    'by_call', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select grp, count(*) as leads, count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed,
          round(avg(talk) filter (where stayed and calls > 0))::int as talk_stayed,
          round(avg(talk) filter (where joined and calls > 0))::int as talk_joined,
          round(avg(talk) filter (where not joined and calls > 0))::int as talk_not_joined
        from f group by grp) x),
    'by_caller', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select grouping(caller) as g, caller, grp, count(*) as leads, count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed,
          round(avg(talk) filter (where stayed and calls > 0))::int as talk_stayed
        from f group by grouping sets ((caller, grp), (grp))) x),
    'by_outcome', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select grouping(caller) as g, caller, outcome, count(*) as leads, count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed
        from (select caller, joined, stayed,
                case when grp in ('connected', 'not_connected') then coalesce(outcome_id::text, 'no_outcome') when grp = 'holdout' then 'holdout' else 'not_called' end as outcome
              from f) o
        group by grouping sets ((caller, outcome), (outcome))) x),
    'patterns', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select dim, bucket, count(*) as leads, count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed
        from dims group by dim, bucket) x)
  )
$$;
revoke execute on function public.show_up_report(uuid, text) from anon, public;
grant execute on function public.show_up_report(uuid, text) to authenticated;

-- The leads behind any show-up number. p_filter keys (all optional): grp, joined, stayed, registered, caller
-- ('none' = no caller), outcome ('not_called' | 'no_outcome' | 'holdout' | an outcome id), dim + bucket.
create or replace function public.show_up_leads(p_batch uuid, p_scope text, p_filter jsonb)
returns table(lead_id uuid, name text, phone text, caller uuid, registered boolean, watch_minutes integer, calls integer, talk integer,
  longest integer, outcome_id uuid, prev_at timestamptz, prev_minutes numeric)
language sql stable security definer set search_path = '' as $$
  select f.lead_id, f.name, f.phone, f.caller, f.registered, f.watch_minutes, f.calls, f.talk, f.longest, f.outcome_id, f.prev_at, f.prev_minutes
  from public.show_up_facts(p_batch, p_scope) f
  where (p_filter->>'grp' is null or f.grp = p_filter->>'grp')
    and (p_filter->>'joined' is null or f.joined = (p_filter->>'joined')::boolean)
    and (p_filter->>'stayed' is null or f.stayed = (p_filter->>'stayed')::boolean)
    and (p_filter->>'registered' is null or f.registered = (p_filter->>'registered')::boolean)
    and (p_filter->>'caller' is null or coalesce(f.caller::text, 'none') = p_filter->>'caller')
    and (p_filter->>'outcome' is null or p_filter->>'outcome' = case when f.grp in ('connected', 'not_connected') then coalesce(f.outcome_id::text, 'no_outcome')
                                                                    when f.grp = 'holdout' then 'holdout' else 'not_called' end)
    and (p_filter->>'dim' is null or (f.registered and not f.is_holdout and p_filter->>'bucket' = case p_filter->>'dim'
          when 'timing' then f.b_timing when 'attempts' then f.b_attempts when 'talk' then f.b_talk when 'hour' then f.b_hour
          when 'registered' then f.b_registered when 'profession' then f.b_profession when 'source' then nullif(f.b_source, 'Zoom attendee') when 'repeat' then f.b_repeat end))
  order by f.watch_minutes desc nulls last, f.name
$$;
revoke execute on function public.show_up_leads(uuid, text, jsonb) from anon, public;
grant execute on function public.show_up_leads(uuid, text, jsonb) to authenticated;
