-- Webinar engagement used by the calling list, the focus list and the watch-time card.

create or replace function public.batch_call_list(p_batch uuid, p_purpose text, p_everyone boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_hot int; v_at timestamptz; v_users uuid[]; res jsonb;
begin
  select org_id, hot_minutes, webinar_at into v_org, v_hot, v_at from public.batches where id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  if p_purpose not in ('sales', 'reminder') then raise exception 'Unknown list type'; end if;
  v_users := case when p_everyone and public.is_org_manager(v_org) then public.visible_user_ids(v_org) else array[auth.uid()] end;

  with bl as (
    select b.lead_id, b.watch_minutes, b.attended, b.is_repeat, b.added_at, b.saw_pitch, b.warmth, b.warm_reason, b.chat_count, b.poll_answered, l.*,
      case when p_purpose = 'reminder' then coalesce(b.reminder_by, l.assigned_to) else l.assigned_to end as rep
    from public.batch_leads b
    join public.leads l on l.id = b.lead_id and l.deleted_at is null
    where b.batch_id = p_batch and not (p_purpose = 'reminder' and b.is_holdout)
  ), vis as (
    select * from bl where bl.rep = any(v_users) or (p_everyone and bl.rep is null and public.is_org_manager(v_org))
  ), c as (
    select k.lead_id, count(*)::int as attempts, bool_or(k.duration_sec > 0) as talked, max(k.started_at) as last_called_at,
      (array_agg(k.outcome_id order by k.started_at desc) filter (where k.outcome_id is not null))[1] as last_outcome_id
    from public.calls k
    where k.lead_id in (select vis.lead_id from vis) and k.purpose = p_purpose
      and (k.batch_id = p_batch or (k.batch_id is null and k.started_at >= (select min(added_at) from vis)))
    group by k.lead_id
  ), f as (
    select fu.lead_id, min(fu.due_at) as next_due from public.follow_ups fu
    where fu.lead_id in (select vis.lead_id from vis) and fu.status = 'pending' and fu.purpose = p_purpose
    group by fu.lead_id
  ), buy as (
    select v.lead_id from vis v join public.customers cu on cu.org_id = v_org
      and (cu.phone = v.phone or (v.email is not null and lower(cu.email) = lower(v.email)))
    group by v.lead_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.lead_id, 'org_id', v.org_id, 'name', v.name, 'phone', v.phone, 'email', v.email, 'city', v.city, 'state', v.state,
      'company', v.company, 'profession', v.profession, 'category_id', v.profession_category_id, 'category', pc.name,
      'source', v.source, 'campaign', v.campaign, 'rep', v.rep, 'assigned_to', v.assigned_to, 'do_not_call', v.do_not_call,
      'watch_minutes', v.watch_minutes, 'attended', coalesce(v.watch_minutes, 0) > 0,
      'is_hot', coalesce(v.watch_minutes, 0) >= v_hot and coalesce(v.watch_minutes, 0) > 0,
      'is_repeat', v.is_repeat, 'registered_at', v.added_at,
      'saw_pitch', v.saw_pitch, 'warmth', v.warmth, 'warm_reason', v.warm_reason, 'chat_count', v.chat_count, 'poll_answered', v.poll_answered,
      'attempts', coalesce(c.attempts, 0), 'talked', coalesce(c.talked, false), 'last_called_at', c.last_called_at,
      'last_outcome_id', coalesce(c.last_outcome_id, v.last_outcome_id), 'next_follow_up_at', f.next_due,
      'bought', buy.lead_id is not null or exists (select 1 from public.calls k2 join public.call_outcomes o on o.id = k2.outcome_id
                                                  where k2.lead_id = v.lead_id and o.category = 'won')
    )), '[]'::jsonb) into res
  from vis v
  left join c on c.lead_id = v.lead_id
  left join f on f.lead_id = v.lead_id
  left join buy on buy.lead_id = v.lead_id
  left join public.profession_categories pc on pc.id = v.profession_category_id;
  return jsonb_build_object('hot_minutes', v_hot, 'webinar_at', v_at, 'leads', res);
end $$;


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
      select l.*, o.category cat,
        -- tonight's webinar (starts within 18 h; reminder calls) and the best recent watch time (last 14 days)
        (select b.webinar_at from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'
          order by b.webinar_at limit 1) up_at,
        (select b.name from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'
          order by b.webinar_at limit 1) up_name,
        -- warmest recent webinar (last 14 days): warmth 40+ (watch + pitch + chat + polls) or watched the hot minutes
        (select max(greatest(bl.warmth, case when coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60) then 40 else 0 end))
           from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and b.webinar_at > now() - interval '14 days' and b.webinar_at <= now()
            and (bl.warmth >= 40 or coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60))) hot_min,
        (select coalesce(bl.warm_reason, '🔥 Watched ' || bl.watch_minutes || ' min') from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and b.webinar_at > now() - interval '14 days' and b.webinar_at <= now()
            and (bl.warmth >= 40 or coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60))
          order by bl.warmth desc, bl.watch_minutes desc nulls last limit 1) hot_reason
      from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
      where l.org_id = p_org and l.deleted_at is null and not l.do_not_call
        and (l.assigned_to = auth.uid() or exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
              where bl.lead_id = l.id and bl.reminder_by = auth.uid() and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'))
        and coalesce(o.category::text, '') not in ('won', 'lost', 'invalid')
    ), todo as (
      select m.*, public.lead_call_context(m.id)->>'purpose' call_purpose, public.lead_call_context(m.id)->>'batch_id' call_batch_id, case
          when m.next_follow_up_at < now() then 1
          when m.up_at is not null then 2
          when m.next_follow_up_at < now() + interval '2 hours' then 3
          when m.hot_min is not null then 4
          when m.dial_count = 0 then 5
          when m.best_hour = extract(hour from now() at time zone v_tz)::int then 6
          when m.score >= 40 then 7 else 8 end bucket,
        case when m.next_follow_up_at < now() then 'Overdue follow-up'
             when m.up_at is not null then '🎓 Reminder · ' || m.up_name || ' at ' || to_char(m.up_at at time zone v_tz, 'FMHH12:MI AM')
             when m.next_follow_up_at < now() + interval '2 hours' then 'Follow-up due'
             when m.hot_min is not null then '🎥 ' || m.hot_reason
             when m.dial_count = 0 then 'New — not called yet'
             when m.best_hour = extract(hour from now() at time zone v_tz)::int then '⏰ Best time to call now' when m.score >= 40 then '⚡ Close to converting' else null end reason
      from mine m
      where (m.next_follow_up_at is null or m.next_follow_up_at < v_day_end)      -- planned for a later day: not today
        and (m.last_call_at is null or m.last_call_at < v_day_start or m.next_follow_up_at < now() + interval '2 hours')
    )
    select jsonb_build_object(
      'total', (select count(*) from todo),
      'done_today', (select count(*) from mine where last_call_at >= v_day_start),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) - 'up_at' - 'up_name' - 'hot_min' - 'hot_reason' order by t.bucket, t.up_at nulls last, t.next_follow_up_at nulls last,
                  t.hot_min desc nulls last, case when t.bucket = 5 then -extract(epoch from t.created_at) end, t.score desc, t.last_call_at nulls first), '[]')
               from (select * from todo order by bucket, up_at nulls last, next_follow_up_at nulls last, hot_min desc nulls last,
                     case when bucket = 5 then -extract(epoch from created_at) end, score desc, last_call_at nulls first
                     limit p_limit offset p_offset) t)
    ));
end $function$;

create or replace function public.batch_watch_bands(p_batch uuid)
returns jsonb language sql stable security invoker set search_path = public as $$
  with b as (select id, pitch_minute, zoom_uploaded_at from batches where id = p_batch),
  x as (
    select bl.watch_minutes w, bl.saw_pitch sp, l.dial_count > 0 called, l.has_talked talked,
      (l.won_at is not null or exists (select 1 from customers cu where cu.org_id = l.org_id
         and (cu.phone = l.phone or (l.email is not null and lower(cu.email) = lower(l.email))))) won
    from batch_leads bl join leads l on l.id = bl.lead_id and l.deleted_at is null
    where bl.batch_id = p_batch
  ),
  g as (
    select case when w is null then -2 when w = 0 then -1 else (w - 1) / 10 end k,
      count(*) leads, count(*) filter (where called) called, count(*) filter (where talked) talked, count(*) filter (where won) won
    from x group by 1
  ),
  p as (
    select case when x.w is null then 'not_uploaded' when x.w = 0 then 'absent'
                when b.pitch_minute is null then 'joined'
                when x.sp then 'saw' else 'before' end k,
      count(*) leads, count(*) filter (where called) called, count(*) filter (where talked) talked, count(*) filter (where won) won
    from x, b group by 1
  )
  select jsonb_build_object(
    'pitch_minute', (select pitch_minute from b),
    'zoom_uploaded', (select zoom_uploaded_at is not null from b),
    'exact', (select count(*) > 0 from batch_leads where batch_id = p_batch and at_pitch is not null),
    'warmth', (select jsonb_build_object('hot', count(*) filter (where bl.warmth >= 70), 'warm', count(*) filter (where bl.warmth between 40 and 69),
                 'cold', count(*) filter (where bl.warmth between 1 and 39)) from batch_leads bl join leads l on l.id = bl.lead_id and l.deleted_at is null where bl.batch_id = p_batch),
    'bands', coalesce((select jsonb_agg(jsonb_build_object('k', k,
        'from', case when k < 0 then null else k * 10 + 1 end, 'to', case when k < 0 then null else k * 10 + 10 end,
        'leads', leads, 'called', called, 'talked', talked, 'won', won) order by k) from g), '[]'::jsonb),
    'pitch', coalesce((select jsonb_object_agg(k, jsonb_build_object('leads', leads, 'called', called, 'talked', talked, 'won', won)) from p), '{}'::jsonb));
$$;
