-- Round 15 · 8) Team performance: activity, results, reminder show-up and CRM hygiene per team member, all sortable.
-- Owner (Nov 17): numbers and facts only — no colour-coding by performance (each company sets its own targets).
-- CRM hygiene = how well a rep keeps the CRM, scored on six facts (each a %), marks = their average (0–100):
--   notes on conversations · follow-ups called on time (≤ 15 min) · new leads called within the company's target
--   (settings.response.target_min, default 15 working min) · assigned leads called at least once ·
--   profession + city filled on leads they talked to · working days with 5+ dialled calls.
-- A conversation = a call (dialled or received) longer than 30 seconds — the same 30-second rule as the webinar pages.

create or replace function public.team_performance(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; v_tz text; v_target int; v_until timestamptz := least(p_to, now()); res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := case when public.is_org_manager(p_org) then public.visible_user_ids(p_org) else array[auth.uid()] end;
  select o.timezone, coalesce(nullif(o.settings->'response'->>'target_min', '')::int, 15) into v_tz, v_target
  from public.organizations o where o.id = p_org;

  with m as (
    select om.user_id, om.call_team, coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1)) as name
    from public.org_members om join public.profiles p on p.id = om.user_id
    where om.org_id = p_org and om.status = 'active' and om.user_id = any(v_users)
  ),
  k as (
    select c.* from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to and c.user_id = any(v_users)
  ),
  c as (
    select k.user_id,
      count(*) filter (where k.direction = 'outgoing') as dialled,
      count(*) filter (where k.direction = 'outgoing' and k.duration_sec > 30) as answered,
      count(*) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30) as conversations,
      coalesce(sum(k.duration_sec) filter (where k.direction in ('outgoing', 'incoming')), 0) as talk_sec,
      count(*) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30 and k.lead_id is not null) as conv_lead,
      count(*) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30 and k.lead_id is not null
        and (nullif(trim(coalesce(k.notes, '')), '') is not null or jsonb_array_length(coalesce(k.outcome_data->'note_tags', '[]'::jsonb)) > 0)) as conv_noted,
      count(distinct k.lead_id) filter (where k.direction in ('outgoing', 'incoming') and k.duration_sec > 30) as leads_talked
    from k group by k.user_id
  ),
  d as (   -- working days with 5+ dialled calls
    select x.user_id, count(*) filter (where x.n >= 5) as active_days from (
      select k.user_id, (k.started_at at time zone v_tz)::date as day, count(*) as n from k where k.direction = 'outgoing' group by 1, 2) x
    group by x.user_id
  ),
  fu as (
    select f.assigned_to as user_id,
      count(*) filter (where f.dialled_at is not null or now() > f.due_at + interval '15 minutes') as due,
      count(*) filter (where f.dialled_at is not null and f.dialled_at <= f.due_at + interval '15 minutes') as on_time
    from public.follow_ups f
    where f.org_id = p_org and f.due_at >= p_from and f.due_at < p_to and f.status <> 'cancelled' and f.assigned_to = any(v_users)
    group by 1
  ),
  la as (   -- leads assigned in the period
    select l.assigned_to as user_id, count(*) as assigned,
      count(*) filter (where l.first_dialled_at is not null) as assigned_called,
      count(*) filter (where l.is_live) as live,
      count(*) filter (where l.is_live and l.response_sec is not null and l.response_sec <= v_target * 60) as live_fast,
      percentile_cont(0.5) within group (order by l.response_sec) filter (where l.is_live and l.response_sec is not null) as resp_median
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and l.assigned_at >= p_from and l.assigned_at < p_to and l.assigned_to = any(v_users)
    group by 1
  ),
  pr as (   -- leads talked to in the period: profession and city filled?
    select k.user_id, count(distinct l.id) as talked,
      count(distinct l.id) filter (where nullif(trim(coalesce(l.profession, '')), '') is not null and nullif(trim(coalesce(l.city, '')), '') is not null) as filled
    from k join public.leads l on l.id = k.lead_id and l.deleted_at is null
    where k.duration_sec > 30 group by 1
  ),
  s as (
    select sa.credited_to as user_id, count(*) as sales, coalesce(sum(sa.amount), 0) as revenue,
      percentile_cont(0.5) within group (order by extract(epoch from sa.sold_at - l.first_dialled_at) / 86400)
        filter (where l.first_dialled_at is not null and sa.sold_at >= l.first_dialled_at) as close_days
    from public.sales sa left join public.leads l on l.id = sa.lead_id
    where sa.org_id = p_org and sa.status = 'verified' and sa.sold_at >= p_from and sa.sold_at < p_to and sa.credited_to = any(v_users)
    group by 1
  ),
  su as (   -- reminder callers: registrants of webinars held in the period
    select coalesce(bl.reminder_by, l.assigned_to) as user_id, count(*) as rem_leads,
      count(*) filter (where coalesce(bl.watch_minutes, 0) > 0) as rem_joined,
      count(*) filter (where coalesce(bl.watch_minutes, 0) > 0 and bl.watch_minutes >= b.hot_minutes) as rem_stayed,
      count(*) filter (where sp.spoke) as rem_spoke,
      count(*) filter (where sp.spoke and coalesce(bl.watch_minutes, 0) > 0) as rem_spoke_joined
    from public.batch_leads bl
    join public.batches b on b.id = bl.batch_id
    join public.leads l on l.id = bl.lead_id and l.deleted_at is null
    left join lateral (select exists (select 1 from public.calls rc where rc.batch_id = bl.batch_id and rc.lead_id = bl.lead_id
      and rc.purpose = 'reminder' and rc.started_at < b.webinar_at and rc.duration_sec > 30) as spoke) sp on true
    where b.org_id = p_org and b.webinar_at >= p_from and b.webinar_at < p_to and b.zoom_uploaded_at is not null
      and bl.registered and not bl.is_holdout and coalesce(bl.reminder_by, l.assigned_to) = any(v_users)
    group by 1
  ),
  rows as (
    select m.user_id, m.name, m.call_team,
      coalesce(c.dialled, 0) dialled, coalesce(c.answered, 0) answered, coalesce(c.conversations, 0) conversations,
      coalesce(c.talk_sec, 0) talk_sec, coalesce(c.leads_talked, 0) leads_talked,
      coalesce(s.sales, 0) sales, coalesce(s.revenue, 0) revenue, round(s.close_days::numeric, 1) close_days,
      coalesce(la.assigned, 0) assigned, coalesce(la.assigned_called, 0) assigned_called,
      coalesce(la.live, 0) live, coalesce(la.live_fast, 0) live_fast, round((la.resp_median / 60)::numeric) resp_median_min,
      coalesce(fu.due, 0) fu_due, coalesce(fu.on_time, 0) fu_on_time,
      coalesce(c.conv_lead, 0) conv_lead, coalesce(c.conv_noted, 0) conv_noted,
      coalesce(pr.talked, 0) profile_talked, coalesce(pr.filled, 0) profile_filled,
      coalesce(d.active_days, 0) active_days,
      greatest(public.working_days(p_org, m.user_id, (p_from at time zone v_tz)::date, ((v_until - interval '1 second') at time zone v_tz)::date), 0) work_days,
      coalesce(su.rem_leads, 0) rem_leads, coalesce(su.rem_joined, 0) rem_joined, coalesce(su.rem_stayed, 0) rem_stayed,
      coalesce(su.rem_spoke, 0) rem_spoke, coalesce(su.rem_spoke_joined, 0) rem_spoke_joined
    from m
    left join c on c.user_id = m.user_id left join d on d.user_id = m.user_id left join fu on fu.user_id = m.user_id
    left join la on la.user_id = m.user_id left join pr on pr.user_id = m.user_id left join s on s.user_id = m.user_id
    left join su on su.user_id = m.user_id
  ),
  scored as (
    select r.*,
      case when r.conv_lead > 0 then round(r.conv_noted * 100.0 / r.conv_lead) end notes_pct,
      case when r.fu_due > 0 then round(r.fu_on_time * 100.0 / r.fu_due) end fu_pct,
      case when r.live > 0 then round(r.live_fast * 100.0 / r.live) end fast_pct,
      case when r.assigned > 0 then round(r.assigned_called * 100.0 / r.assigned) end called_pct,
      case when r.profile_talked > 0 then round(r.profile_filled * 100.0 / r.profile_talked) end profile_pct,
      -- Days with 5+ calls only count for someone who worked leads in the period (an owner who doesn't call gets no marks, not 0).
      case when r.work_days > 0 and (r.dialled > 0 or r.assigned > 0 or r.fu_due > 0) then round(least(r.active_days, r.work_days) * 100.0 / r.work_days) end active_pct,
      case when r.dialled > 0 then round(r.answered * 100.0 / r.dialled) end pickup_pct,
      case when r.leads_talked > 0 then round(r.sales * 100.0 / r.leads_talked, 1) end close_pct,
      case when r.rem_leads > 0 then round(r.rem_joined * 100.0 / r.rem_leads) end showup_pct,
      case when r.rem_spoke > 0 then round(r.rem_spoke_joined * 100.0 / r.rem_spoke) end spoke_showup_pct
    from rows r
  )
  select jsonb_build_object(
    'target_min', v_target,
    'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.talk_sec desc), '[]'::jsonb)
  ) into res
  from (select sc.*,
          (select round(avg(v)) from unnest(array[sc.notes_pct, sc.fu_pct, sc.fast_pct, sc.called_pct, sc.profile_pct, sc.active_pct]) v where v is not null) as hygiene
        from scored sc) x;
  return res;
end $$;
grant execute on function public.team_performance(uuid, timestamptz, timestamptz) to authenticated;

-- The leads behind a Team performance number for one team member.
-- p_metric: dialled · talked · no_notes · fu_on_time · fu_late · assigned · not_called · slow · profile_missing · sales ·
--           rem_all · rem_joined · rem_not_joined · rem_spoke
create or replace function public.team_perf_leads(p_org uuid, p_from timestamptz, p_to timestamptz, p_user uuid, p_metric text)
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
declare v_target int;
begin
  if not public.is_org_member(p_org) or not (p_user = auth.uid() or (public.is_org_manager(p_org) and p_user = any(public.visible_user_ids(p_org)))) then
    raise exception 'Not allowed';
  end if;
  select coalesce(nullif(o.settings->'response'->>'target_min', '')::int, 15) into v_target from public.organizations o where o.id = p_org;
  if p_metric in ('dialled', 'talked', 'no_notes', 'profile_missing') then
    return query
      select k.lead_id from public.calls k join public.leads l on l.id = k.lead_id and l.deleted_at is null
      where k.org_id = p_org and k.user_id = p_user and k.started_at >= p_from and k.started_at < p_to
        and case p_metric
          when 'dialled' then k.direction = 'outgoing'
          when 'talked' then k.direction in ('outgoing', 'incoming') and k.duration_sec > 30
          when 'no_notes' then k.direction in ('outgoing', 'incoming') and k.duration_sec > 30
            and nullif(trim(coalesce(k.notes, '')), '') is null and jsonb_array_length(coalesce(k.outcome_data->'note_tags', '[]'::jsonb)) = 0
          else k.duration_sec > 30 and (nullif(trim(coalesce(l.profession, '')), '') is null or nullif(trim(coalesce(l.city, '')), '') is null) end
      group by k.lead_id order by max(k.started_at) desc;
  elsif p_metric in ('fu_on_time', 'fu_late') then
    return query
      select f.lead_id from public.follow_ups f
      where f.org_id = p_org and f.assigned_to = p_user and f.due_at >= p_from and f.due_at < p_to and f.status <> 'cancelled'
        and case when p_metric = 'fu_on_time' then f.dialled_at is not null and f.dialled_at <= f.due_at + interval '15 minutes'
                 else (f.dialled_at is not null and f.dialled_at > f.due_at + interval '15 minutes') or (f.dialled_at is null and now() > f.due_at + interval '15 minutes') end
      group by f.lead_id order by max(f.due_at) desc;
  elsif p_metric in ('assigned', 'not_called', 'slow') then
    return query
      select l.id from public.leads l
      where l.org_id = p_org and l.deleted_at is null and l.assigned_to = p_user and l.assigned_at >= p_from and l.assigned_at < p_to
        and case p_metric when 'assigned' then true when 'not_called' then l.first_dialled_at is null
          else l.is_live and (l.response_sec is null or l.response_sec > v_target * 60) end
      order by l.assigned_at desc;
  elsif p_metric = 'sales' then
    return query
      select sa.lead_id from public.sales sa
      where sa.org_id = p_org and sa.credited_to = p_user and sa.status = 'verified' and sa.sold_at >= p_from and sa.sold_at < p_to and sa.lead_id is not null
      group by sa.lead_id order by max(sa.sold_at) desc;
  elsif p_metric like 'rem_%' then
    return query
      select bl.lead_id from public.batch_leads bl join public.batches b on b.id = bl.batch_id join public.leads l on l.id = bl.lead_id and l.deleted_at is null
      where b.org_id = p_org and b.webinar_at >= p_from and b.webinar_at < p_to and b.zoom_uploaded_at is not null and bl.registered and not bl.is_holdout
        and coalesce(bl.reminder_by, l.assigned_to) = p_user
        and case p_metric when 'rem_joined' then coalesce(bl.watch_minutes, 0) > 0 when 'rem_not_joined' then coalesce(bl.watch_minutes, 0) = 0
          when 'rem_spoke' then exists (select 1 from public.calls rc where rc.batch_id = bl.batch_id and rc.lead_id = bl.lead_id
            and rc.purpose = 'reminder' and rc.started_at < b.webinar_at and rc.duration_sec > 30)
          else true end
      group by bl.lead_id;
  end if;
end $$;
grant execute on function public.team_perf_leads(uuid, timestamptz, timestamptz, uuid, text) to authenticated;
