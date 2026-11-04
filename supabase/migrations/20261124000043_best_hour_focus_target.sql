-- Extras: each lead's best pick-up hour, best-hour-now in today's focus, a daily focus target per rep.
alter table public.leads add column if not exists best_hour int;
alter table public.rep_targets add column if not exists focus_leads int;

CREATE OR REPLACE FUNCTION public.refresh_lead_stats(p_lead uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_last record; v_cat public.outcome_category; v_watch int; v_score numeric := 0; v_dnc boolean; v_lc timestamptz;
begin
  if p_lead is null then return; end if;
  select coalesce(sum(c.duration_sec), 0) talk,
         count(*) filter (where c.direction = 'outgoing') dials,
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, o.category)) picks,
         min(c.started_at) filter (where c.direction = 'outgoing') first_dial,
         min(c.started_at) filter (where o.category = 'won') won
    into s
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id where c.lead_id = p_lead;

  select c.direction, c.duration_sec, o.category into v_last
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.lead_id = p_lead order by c.started_at desc limit 1;

  select o.category, l.do_not_call, l.last_connected_at into v_cat, v_dnc, v_lc
  from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id where l.id = p_lead;
  select max(watch_minutes) into v_watch from public.batch_leads where lead_id = p_lead;

  -- Close-to-converting score (open leads only).
  if not coalesce(v_dnc, false) and coalesce(v_cat::text, '') not in ('won', 'lost', 'invalid') then
    v_score := least(s.picks, 3) * 12
             + least(s.talk / 60.0 / 30.0, 1) * 24
             + case v_cat when 'positive' then 20 when 'connected' then 8 else 0 end
             + case when coalesce(v_watch, 0) >= 60 then 15 when coalesce(v_watch, 0) > 0 then 6 else 0 end
             + case when v_lc > now() - interval '3 days' then 5 else 0 end;
  end if;

  update public.leads l set
    total_talk_sec = s.talk, dial_count = s.dials, pickup_count = s.picks,
    first_dialled_at = s.first_dial, won_at = s.won,
    first_talk_dial = (select n from (
        select row_number() over (order by c.started_at) n, public.is_real_pickup(c.direction, c.duration_sec, o.category) p
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = p_lead and c.direction = 'outgoing') x where p order by n limit 1),
    last_call_status = case
        when v_last.direction is null then null
        when v_last.direction in ('missed', 'rejected') then 'missed'
        when v_last.direction = 'incoming' then case when coalesce(v_last.duration_sec, 0) > 0 then 'talked' else 'missed' end
        when public.is_real_pickup(v_last.direction, v_last.duration_sec, v_last.category) then 'talked'
        else 'not_picked' end,
    wa_count = (select count(*) from public.wa_messages w where w.lead_id = p_lead and w.undone_at is null),
    score = round(v_score)::int,
    best_hour = (select hr from (
        select extract(hour from c.started_at at time zone coalesce(o2.timezone, 'Asia/Kolkata'))::int hr, count(*) n
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        join public.leads l2 on l2.id = c.lead_id join public.organizations o2 on o2.id = l2.org_id
        where c.lead_id = p_lead and public.is_real_pickup(c.direction, c.duration_sec, o.category)
        group by 1 having count(*) >= 2 order by 2 desc, 1 limit 1) b)
  where l.id = p_lead;
end $function$;

CREATE OR REPLACE FUNCTION public.target_progress(p_org uuid, p_from date, p_to date, p_users uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_users uuid[]; v_days int; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'Choose up to 3 months'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  v_days := public.working_days(p_org, null, p_from, p_to);

  with people as (
    select m.user_id, public.working_days(p_org, m.user_id, p_from, p_to) days
    from public.org_members m where m.org_id = p_org and m.status = 'active' and m.user_id = any(v_users)
  ), t as (
    select p.user_id, p.days,
      coalesce(r.calls, d.calls) as calls, coalesce(r.conversations, d.conversations) as conversations,
      coalesce(r.talk_minutes, d.talk_minutes) as talk_minutes, coalesce(r.sales, d.sales) as sales, coalesce(r.focus_leads, d.focus_leads) as focus,
      r.id is not null as own
    from people p
    left join public.rep_targets r on r.org_id = p_org and r.user_id = p.user_id
    left join public.rep_targets d on d.org_id = p_org and d.user_id is null
  ), a as (
    select c.user_id,
      count(*) filter (where c.direction = 'outgoing') as calls,
      count(*) filter (where c.duration_sec > 0) as conversations,
      coalesce(sum(c.duration_sec), 0) / 60 as talk_minutes,
      count(*) filter (where o.category = 'won') as sales
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.user_id = any(v_users)
      and c.started_at >= (p_from::timestamp at time zone v_tz) and c.started_at < ((p_to + 1)::timestamp at time zone v_tz)
    group by c.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'own_target', t.own, 'work_days', t.days,
      'target', jsonb_build_object('calls', t.calls * t.days, 'conversations', t.conversations * t.days,
                                   'talk_minutes', t.talk_minutes * t.days, 'sales', t.sales * t.days),
      'daily', jsonb_build_object('calls', t.calls, 'conversations', t.conversations, 'talk_minutes', t.talk_minutes, 'sales', t.sales, 'focus', t.focus),
      'actual', jsonb_build_object('calls', coalesce(a.calls, 0), 'conversations', coalesce(a.conversations, 0),
                                   'talk_minutes', coalesce(a.talk_minutes, 0), 'sales', coalesce(a.sales, 0))
    )), '[]'::jsonb) into res
  from t left join a on a.user_id = t.user_id;
  return jsonb_build_object('work_days', v_days, 'rows', res);
end $function$;

CREATE OR REPLACE FUNCTION public.my_focus_list(p_org uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_day_start timestamptz; v_day_end timestamptz;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_day_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';
  return (with mine as (
      select l.*, o.category cat from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
      where l.org_id = p_org and l.deleted_at is null and l.assigned_to = auth.uid() and not l.do_not_call
        and coalesce(o.category::text, '') not in ('won', 'lost', 'invalid')
    ), todo as (
      select m.*, case
          when m.next_follow_up_at < now() then 1
          when m.next_follow_up_at < now() + interval '2 hours' then 2
          when m.dial_count = 0 then 3
          when m.best_hour = extract(hour from now() at time zone v_tz)::int then 4
          when m.score >= 40 then 5 else 6 end bucket,
        case when m.next_follow_up_at < now() then 'Overdue follow-up' when m.next_follow_up_at < now() + interval '2 hours' then 'Follow-up due'
             when m.dial_count = 0 then 'New — not called yet'
             when m.best_hour = extract(hour from now() at time zone v_tz)::int then '⏰ Best time to call now' when m.score >= 40 then '🔥 Close to converting' else null end reason
      from mine m
      where (m.next_follow_up_at is null or m.next_follow_up_at < v_day_end)      -- planned for a later day: not today
        and (m.last_call_at is null or m.last_call_at < v_day_start or m.next_follow_up_at < now() + interval '2 hours')
    )
    select jsonb_build_object(
      'total', (select count(*) from todo),
      'done_today', (select count(*) from mine where last_call_at >= v_day_start),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) order by t.bucket, t.next_follow_up_at nulls last,
                  case when t.bucket = 3 then extract(epoch from t.created_at) end, t.score desc, t.last_call_at nulls first), '[]')
               from (select * from todo order by bucket, next_follow_up_at nulls last, case when bucket = 3 then created_at end, score desc, last_call_at nulls first
                     limit p_limit offset p_offset) t)
    ));
end $function$;

CREATE OR REPLACE FUNCTION public.set_rep_target(p_org uuid, p_user uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can set targets'; end if;
  if p_user is not null and not exists (select 1 from public.org_members where org_id = p_org and user_id = p_user) then
    raise exception 'Not in this company';
  end if;
  if p_user is null then
    delete from public.rep_targets where org_id = p_org and user_id is null;
  else
    delete from public.rep_targets where org_id = p_org and user_id = p_user;
  end if;
  if coalesce(nullif(p->>'calls',''), nullif(p->>'conversations',''), nullif(p->>'talk_minutes',''), nullif(p->>'sales',''), nullif(p->>'focus_leads','')) is not null then
    insert into public.rep_targets (org_id, user_id, calls, conversations, talk_minutes, sales, focus_leads, updated_by)
    values (p_org, p_user, nullif(p->>'calls', '')::int, nullif(p->>'conversations', '')::int,
            nullif(p->>'talk_minutes', '')::int, nullif(p->>'sales', '')::int, nullif(p->>'focus_leads', '')::int, auth.uid());
  end if;
end $function$;

do $$ declare l record; begin
  for l in select id from public.leads where deleted_at is null and pickup_count >= 2 loop perform public.refresh_lead_stats(l.id); end loop;
end $$;
