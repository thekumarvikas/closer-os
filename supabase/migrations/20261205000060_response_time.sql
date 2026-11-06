-- Lead response time ("speed to lead"): working time from when a lead reached the rep (arrival, or
-- assignment if later) to the first call. Working time = the company's work days (settings.work_days,
-- holidays skipped) between settings.response.start_hour and end_hour (default 9–21), company time zone.
-- Only leads that arrive one by one count ("live"): bulk imports (5+ leads created in the same moment)
-- and leads created from a phone call are left out.

alter table public.leads add column if not exists response_sec int;   -- working seconds to the first call

create or replace function public.work_seconds(p_org uuid, p_a timestamptz, p_b timestamptz)
returns int language plpgsql stable security definer set search_path = '' as $$
declare tz text; sh int; eh int; wd int[]; d date; d1 date; s timestamptz; e timestamptz; total numeric := 0;
begin
  if p_a is null or p_b is null or p_b <= p_a then return 0; end if;
  select o.timezone, coalesce((o.settings->'response'->>'start_hour')::int, 9), coalesce((o.settings->'response'->>'end_hour')::int, 21),
         coalesce((select array_agg(x::int) from jsonb_array_elements_text(o.settings->'work_days') x), array[1,2,3,4,5,6])
    into tz, sh, eh, wd from public.organizations o where o.id = p_org;
  d := (p_a at time zone tz)::date; d1 := least((p_b at time zone tz)::date, d + 90);
  while d <= d1 loop
    if extract(isodow from d)::int = any(wd) and not exists (select 1 from public.org_holidays h where h.org_id = p_org and h.day = d) then
      s := greatest(p_a, (d + make_time(sh, 0, 0)) at time zone tz);
      e := least(p_b, (d + make_time(least(eh, 23), case when eh >= 24 then 59 else 0 end, 0)) at time zone tz);
      if e > s then total := total + extract(epoch from e - s); end if;
    end if;
    d := d + 1;
  end loop;
  return total::int;
end $$;
revoke execute on function public.work_seconds(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.work_seconds(uuid, timestamptz, timestamptz) to authenticated;

-- A lead that arrived on its own (not a bulk import, not created from a call).
create or replace function public.lead_is_live(l public.leads)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(l.source, '') <> 'Phone call'
     and (select count(*) from public.leads x where x.org_id = l.org_id and x.created_at = l.created_at) < 5
$$;

-- When the rep got it: assignment time if that came after arrival (and before the first call).
create or replace function public.lead_start_at(l public.leads)
returns timestamptz language sql immutable as $$
  select case when l.assigned_at is not null and l.assigned_at > l.created_at
              and (l.first_dialled_at is null or l.assigned_at <= l.first_dialled_at) then l.assigned_at else l.created_at end
$$;

create or replace function public.t_lead_response() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.first_dialled_at is not null and old.first_dialled_at is null then
    new.response_sec := public.work_seconds(new.org_id, public.lead_start_at(new), new.first_dialled_at);
  end if;
  return new;
end $$;
drop trigger if exists t_lead_response on public.leads;
create trigger t_lead_response before update of first_dialled_at on public.leads for each row execute function public.t_lead_response();

update public.leads l set response_sec = public.work_seconds(l.org_id, public.lead_start_at(l), l.first_dialled_at)
where l.first_dialled_at is not null and l.response_sec is null;

-- The report: managers see their people (+ unassigned), reps see themselves.
create or replace function public.response_report(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_mgr boolean; v_target int;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone, coalesce((settings->'response'->>'target_min')::int, 15) into v_tz, v_target from public.organizations where id = p_org;
  v_mgr := public.is_org_manager(p_org);
  v_users := case when v_mgr then public.visible_user_ids(p_org) else array[auth.uid()] end;
  return (with l as (
      select l.id, l.name, l.phone, l.assigned_to, l.created_at, public.lead_start_at(l) start_at, l.first_dialled_at,
        (l.first_dialled_at is not null) responded,
        coalesce(l.response_sec, public.work_seconds(l.org_id, public.lead_start_at(l), coalesce(l.first_dialled_at, now()))) sec
      from public.leads l
      where l.org_id = p_org and l.deleted_at is null
        and (l.created_at at time zone v_tz)::date between p_from and p_to
        and (l.assigned_to = any(v_users) or (v_mgr and l.assigned_to is null))
        and public.lead_is_live(l)
    ), r as (select * from l where responded)
    select jsonb_build_object(
      'target_min', v_target,
      'total', jsonb_build_object('arrived', (select count(*) from l), 'responded', (select count(*) from r),
        'waiting', (select count(*) from l where not responded),
        'median_min', (select round((percentile_cont(0.5) within group (order by sec) / 60.0)::numeric, 1) from r),
        'avg_min', (select round(avg(sec) / 60.0, 1) from r),
        'within', (select count(*) from r where sec <= v_target * 60),
        'b5', (select count(*) from r where sec <= 300), 'b15', (select count(*) from r where sec > 300 and sec <= 900),
        'b60', (select count(*) from r where sec > 900 and sec <= 3600), 'b240', (select count(*) from r where sec > 3600 and sec <= 14400),
        'bmore', (select count(*) from r where sec > 14400)),
      'people', (select coalesce(jsonb_agg(x order by (x->>'median_min')::numeric nulls last), '[]') from (
          select jsonb_build_object('user_id', assigned_to, 'arrived', count(*), 'responded', count(*) filter (where responded),
            'waiting', count(*) filter (where not responded),
            'median_min', round((percentile_cont(0.5) within group (order by sec) filter (where responded) / 60.0)::numeric, 1),
            'within', count(*) filter (where responded and sec <= v_target * 60),
            'oldest_wait_min', round(max(sec) filter (where not responded) / 60.0)) x
          from l where assigned_to is not null group by assigned_to) t),
      'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'arrived', n, 'median_min', m, 'within', w, 'responded', rr) order by d), '[]') from (
          select (created_at at time zone v_tz)::date d, count(*) n, count(*) filter (where responded) rr,
            round((percentile_cont(0.5) within group (order by sec) filter (where responded) / 60.0)::numeric, 1) m,
            count(*) filter (where responded and sec <= v_target * 60) w
          from l group by 1) t),
      'waiting_list', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'assigned_to', assigned_to,
            'created_at', created_at, 'wait_min', round(sec / 60.0)) order by sec desc), '[]')
          from (select * from l where not responded order by sec desc limit 50) t),
      'slowest', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'assigned_to', assigned_to,
            'created_at', created_at, 'min', round(sec / 60.0)) order by sec desc), '[]')
          from (select * from r order by sec desc limit 20) t)
    ));
end $$;
revoke execute on function public.response_report(uuid, date, date) from anon, public;
grant execute on function public.response_report(uuid, date, date) to authenticated;

-- Focus list: a new lead waiting (arrived on its own in the last 24 h, never called) comes right after late
-- follow-ups and tonight's reminder calls — longest waiting first.
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
        , (l.dial_count = 0 and l.created_at > now() - interval '24 hours' and public.lead_is_live(l)) new_live
      from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
      where l.org_id = p_org and l.deleted_at is null and not l.do_not_call
        and (l.assigned_to = auth.uid() or auth.uid() = any(l.shared_with) or exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
              where bl.lead_id = l.id and bl.reminder_by = auth.uid() and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'))
        and coalesce(o.category::text, '') not in ('won', 'lost', 'invalid')
    ), todo as (
      select m.*, public.lead_call_context(m.id)->>'purpose' call_purpose, public.lead_call_context(m.id)->>'batch_id' call_batch_id, case
          when m.next_follow_up_at < now() then 1
          when m.up_at is not null then 2
          when m.new_live then 3            -- a new lead is waiting: speed to lead
          when m.next_follow_up_at < now() + interval '2 hours' then 4
          when m.hot_min is not null then 5
          when m.dial_count = 0 then 6
          when m.best_hour = extract(hour from now() at time zone v_tz)::int then 7
          when m.score >= 40 then 8 else 9 end bucket,
        case when m.next_follow_up_at < now() then 'Overdue follow-up'
             when m.up_at is not null then '🎓 Reminder · ' || m.up_name || ' at ' || to_char(m.up_at at time zone v_tz, 'FMHH12:MI AM')
             when m.new_live then '🆕 New lead · waiting ' || greatest(1, round(public.work_seconds(m.org_id, greatest(m.created_at, coalesce(m.assigned_at, m.created_at)), now()) / 60.0)) || ' min'
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
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) - 'up_at' - 'up_name' - 'hot_min' - 'hot_reason' - 'new_live' order by t.bucket, t.up_at nulls last, t.next_follow_up_at nulls last,
                  t.hot_min desc nulls last, case when t.bucket = 6 then -extract(epoch from t.created_at) when t.bucket = 3 then extract(epoch from t.created_at) end, t.score desc, t.last_call_at nulls first), '[]')
               from (select * from todo order by bucket, up_at nulls last, next_follow_up_at nulls last, hot_min desc nulls last,
                     case when bucket = 6 then -extract(epoch from created_at) when bucket = 3 then extract(epoch from created_at) end, score desc, last_call_at nulls first
                     limit p_limit offset p_offset) t)
    ));
end $function$;
