-- Speed fixes found by the load test (40k leads / 60k calls on the Micro server).
-- 1) "Arrived on its own" is stored once per lead instead of counted on every report.
alter table public.leads add column if not exists is_live boolean not null default true;
create or replace function public.t_lead_is_live() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Bulk imports create many leads in the same moment (same transaction time): the 5th one onwards is not "live".
  new.is_live := coalesce(new.source, '') <> 'Phone call'
    and (select count(*) from (select 1 from public.leads x where x.org_id = new.org_id and x.created_at = new.created_at limit 4) y) < 4;
  return new;
end $$;
drop trigger if exists t_lead_is_live on public.leads;
create trigger t_lead_is_live before insert on public.leads for each row execute function public.t_lead_is_live();
update public.leads l set is_live = false where l.is_live and coalesce(l.source, '') = 'Phone call';
update public.leads l set is_live = false
from (select org_id, created_at from public.leads group by 1, 2 having count(*) >= 5) g
where l.is_live and l.org_id = g.org_id and l.created_at = g.created_at;
create or replace function public.lead_is_live(l public.leads)
returns boolean language sql stable set search_path = '' as $$ select l.is_live $$;
create index if not exists leads_live_waiting on public.leads (org_id, assigned_to, created_at) where is_live and first_dialled_at is null and deleted_at is null;

-- 2) Response report: working time is only counted for what is shown (no per-lead day loops).
create or replace function public.response_report(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_mgr boolean; v_target int;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone, coalesce((settings->'response'->>'target_min')::int, 15) into v_tz, v_target from public.organizations where id = p_org;
  v_mgr := public.is_org_manager(p_org);
  v_users := case when v_mgr then public.visible_user_ids(p_org) else array[auth.uid()] end;
  return (with l as (
      select l.id, l.org_id, l.name, l.phone, l.assigned_to, l.created_at, public.lead_start_at(l) start_at,
        (l.first_dialled_at is not null) responded, l.response_sec sec
      from public.leads l
      where l.org_id = p_org and l.deleted_at is null and l.is_live
        and l.created_at >= ((p_from::timestamp) at time zone v_tz) and l.created_at < (((p_to + 1)::timestamp) at time zone v_tz)
        and (l.assigned_to = any(v_users) or (v_mgr and l.assigned_to is null))
    ), r as (select * from l where responded and sec is not null),
    w as (select * from l where not responded)
    select jsonb_build_object(
      'target_min', v_target,
      'total', jsonb_build_object('arrived', (select count(*) from l), 'responded', (select count(*) from r),
        'waiting', (select count(*) from w),
        'median_min', (select round((percentile_cont(0.5) within group (order by sec) / 60.0)::numeric, 1) from r),
        'avg_min', (select round(avg(sec) / 60.0, 1) from r),
        'within', (select count(*) from r where sec <= v_target * 60),
        'b5', (select count(*) from r where sec <= 300), 'b15', (select count(*) from r where sec > 300 and sec <= 900),
        'b60', (select count(*) from r where sec > 900 and sec <= 3600), 'b240', (select count(*) from r where sec > 3600 and sec <= 14400),
        'bmore', (select count(*) from r where sec > 14400)),
      'people', (select coalesce(jsonb_agg(x order by (x->>'median_min')::numeric nulls last), '[]') from (
          select jsonb_build_object('user_id', p.u, 'arrived', p.arrived, 'responded', p.responded, 'waiting', p.waiting,
            'median_min', p.median_min, 'within', p.n_within,
            'oldest_wait_min', case when p.oldest is not null then round(public.work_seconds(p_org, p.oldest, now()) / 60.0) end) x
          from (select assigned_to u, count(*) arrived, count(*) filter (where responded) responded, count(*) filter (where not responded) waiting,
                  round((percentile_cont(0.5) within group (order by sec) filter (where responded) / 60.0)::numeric, 1) median_min,
                  count(*) filter (where responded and sec <= v_target * 60) n_within,
                  min(start_at) filter (where not responded) oldest
                from l where assigned_to is not null group by assigned_to) p) t),
      'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'arrived', n, 'median_min', m, 'within', wi, 'responded', rr) order by d), '[]') from (
          select (created_at at time zone v_tz)::date d, count(*) n, count(*) filter (where responded) rr,
            round((percentile_cont(0.5) within group (order by sec) filter (where responded) / 60.0)::numeric, 1) m,
            count(*) filter (where responded and sec <= v_target * 60) wi
          from l group by 1) t),
      'waiting_list', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'assigned_to', assigned_to,
            'created_at', created_at, 'wait_min', round(public.work_seconds(p_org, start_at, now()) / 60.0)) order by start_at), '[]')
          from (select * from w order by start_at limit 50) t),
      'slowest', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'assigned_to', assigned_to,
            'created_at', created_at, 'min', round(sec / 60.0)) order by sec desc), '[]')
          from (select * from r order by sec desc limit 20) t)
    ));
end $$;

-- 3) Focus list: work out reminder-vs-sales only for the leads on the page.
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
        , (l.dial_count = 0 and l.created_at > now() - interval '24 hours' and l.is_live) new_live
      from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
      where l.org_id = p_org and l.deleted_at is null and not l.do_not_call
        and (l.assigned_to = auth.uid() or auth.uid() = any(l.shared_with) or exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
              where bl.lead_id = l.id and bl.reminder_by = auth.uid() and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'))
        and coalesce(o.category::text, '') not in ('won', 'lost', 'invalid')
    ), todo as (
      select m.*, case
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
               from (select p.*, public.lead_call_context(p.id)->>'purpose' call_purpose, public.lead_call_context(p.id)->>'batch_id' call_batch_id
                     from (select * from todo order by bucket, up_at nulls last, next_follow_up_at nulls last, hot_min desc nulls last,
                     case when bucket = 6 then -extract(epoch from created_at) when bucket = 3 then extract(epoch from created_at) end, score desc, last_call_at nulls first
                     limit p_limit offset p_offset) p) t)
    ));
end $function$;

-- 4) The big call / outcome reports group the same calls many ways: a little more sort memory keeps them off disk.
alter function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean, text[], text[]) set work_mem = '24MB';
alter function public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[], text[]) set work_mem = '24MB';
