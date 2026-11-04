-- Round 9 (part 2): lead work report, path to sale, "what works", insights, daily focus list.

-- "Had a conversation" with a lead at all (dialled real pick-up, or an incoming call where they talked).
alter table public.leads add column if not exists has_talked boolean not null default false;

create or replace function public.t_leads_has_talked() returns trigger language plpgsql as $$
begin
  new.has_talked := coalesce(new.pickup_count, 0) > 0 or exists (
    select 1 from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.lead_id = new.id and c.direction = 'incoming'
      and case when o.category is not null then o.category in ('connected', 'positive', 'won', 'lost') else coalesce(c.duration_sec, 0) >= 20 end);
  return new;
end $$;
drop trigger if exists t_leads_has_talked on public.leads;
create trigger t_leads_has_talked before update of pickup_count, total_talk_sec, last_call_status on public.leads
  for each row execute function public.t_leads_has_talked();
update public.leads set total_talk_sec = total_talk_sec where deleted_at is null;

create or replace function public.lead_is_junk(p_lead public.leads) returns boolean language sql stable security definer set search_path = '' as $$
  select p_lead.do_not_call or coalesce((select o.category = 'invalid' from public.call_outcomes o where o.id = p_lead.last_outcome_id), false)
$$;

-- Leads assigned to these people (optionally assigned between two dates).
create or replace function public.work_leads(p_org uuid, p_users uuid[], p_from date, p_to date)
returns setof public.leads language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; v_tz text;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  return query select l.* from public.leads l
    where l.org_id = p_org and l.deleted_at is null and l.assigned_to = any(v_users)
      and (p_from is null or l.assigned_at >= (p_from::timestamp at time zone v_tz))
      and (p_to is null or l.assigned_at < ((p_to + 1)::timestamp at time zone v_tz));
end $$;

create or replace function public.lead_work_report(p_org uuid, p_users uuid[] default null, p_from date default null, p_to date default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with l as (select w.*, public.lead_is_junk(w) junk from public.work_leads(p_org, p_users, p_from, p_to) w),
  b as (select least(dial_count, 6) n, * from l)
  select jsonb_build_object(
    'totals', (select jsonb_build_object('assigned', count(*), 'dialled', count(*) filter (where dial_count > 0),
        'never', count(*) filter (where dial_count = 0), 'conversation', count(*) filter (where has_talked),
        'not_reached', count(*) filter (where dial_count > 0 and not has_talked and not junk), 'junk', count(*) filter (where junk),
        'avg_dials_to_talk', round(avg(first_talk_dial), 1)) from l),
    'attempts', (select coalesce(jsonb_agg(jsonb_build_object('n', n, 'leads', c, 'talked_on', t_on, 'talked', t, 'not_talked', nt, 'junk', j) order by n), '[]')
      from (select n, count(*) c, count(*) filter (where first_talk_dial = n or (n = 6 and first_talk_dial >= 6)) t_on,
                   count(*) filter (where has_talked) t, count(*) filter (where not has_talked and not junk) nt, count(*) filter (where junk) j
            from b group by n) x),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', assigned_to, 'name', coalesce(p.full_name, p.email),
        'assigned', c, 'dialled', d, 'never', nv, 'conversation', t, 'not_reached', nr, 'junk', j, 'avg_dials_to_talk', a) order by c desc), '[]')
      from (select assigned_to, count(*) c, count(*) filter (where dial_count > 0) d, count(*) filter (where dial_count = 0) nv,
                   count(*) filter (where has_talked) t, count(*) filter (where dial_count > 0 and not has_talked and not junk) nr,
                   count(*) filter (where junk) j, round(avg(first_talk_dial), 1) a
            from l group by assigned_to) y left join public.profiles p on p.id = y.assigned_to)
  )
$$;

-- The leads behind one number of the report.  p_kind: assigned dialled never conversation not_reached junk;
-- with p_attempts (0–6, 6 = 6+) also: all talked_on talked not_talked.
create or replace function public.lead_work_list(p_org uuid, p_users uuid[], p_from date, p_to date, p_kind text, p_attempts int default null, p_user uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(w) order by w.last_call_at desc nulls last), '[]') from (
    select l.*, public.lead_is_junk(l) junk from public.work_leads(p_org, case when p_user is not null then array[p_user] else p_users end, p_from, p_to) l
  ) w
  where (p_attempts is null or least(w.dial_count, 6) = p_attempts)
    and case p_kind
      when 'dialled' then w.dial_count > 0
      when 'never' then w.dial_count = 0
      when 'conversation' then w.has_talked
      when 'talked' then w.has_talked
      when 'talked_on' then w.first_talk_dial = p_attempts or (p_attempts = 6 and w.first_talk_dial >= 6)
      when 'not_reached' then w.dial_count > 0 and not w.has_talked and not w.junk
      when 'not_talked' then not w.has_talked and not w.junk
      when 'junk' then w.junk
      else true end
$$;

-- Effort behind one lead (for converted leads: up to the sale).
create or replace function public.lead_effort(p_lead uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with l as (select * from public.leads where id = p_lead),
  lim as (select coalesce((select won_at from l), now()) at_),
  c as (select c.* , o.category from public.calls c left join public.call_outcomes o on o.id = c.outcome_id, lim
        where c.lead_id = p_lead and c.started_at <= lim.at_ + interval '5 minutes'),
  f as (select fu.* from public.follow_ups fu, lim where fu.lead_id = p_lead and fu.dialled_at is not null and fu.dialled_at <= lim.at_ + interval '5 minutes')
  select jsonb_build_object(
    'won', (select won_at is not null from l), 'won_at', (select won_at from l),
    'talk_min', round((select coalesce(sum(duration_sec), 0) from c) / 60.0, 1),
    'calls', (select count(*) from c where direction = 'outgoing'),
    'received', (select count(*) from c where direction = 'incoming'),
    'picked', (select count(*) from c where public.is_real_pickup(direction, duration_sec, category)),
    'wa', (select count(*) from public.wa_messages w, lim where w.lead_id = p_lead and w.undone_at is null and w.sent_at <= lim.at_ + interval '1 hour'),
    'follow_ups', (select count(*) from f), 'follow_ups_on_time', (select count(*) from f where dialled_at <= due_at + interval '15 minutes'),
    'first_talk_dial', (select first_talk_dial from l),
    'days', (select round(extract(epoch from (lim.at_ - coalesce(l.first_dialled_at, l.created_at))) / 86400.0, 1) from l, lim),
    'category', (select pc.name from l join public.profession_categories pc on pc.id = l.profession_category_id),
    'source', (select source from l), 'deal_value', (select deal_value from l),
    'watch_minutes', (select max(watch_minutes) from public.batch_leads where lead_id = p_lead)
  ) where public.lead_visible(p_lead)
$$;

-- Path to sale / call history for a lead: every call with who, outcome and whether a recording exists.
create or replace function public.lead_path(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  return jsonb_build_object('effort', public.lead_effort(p_lead),
    'calls', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'started_at', c.started_at, 'direction', c.direction,
        'duration_sec', c.duration_sec, 'outcome', o.label, 'category', o.category, 'by', coalesce(p.full_name, p.email),
        'recording', c.recording_path is not null and c.recording_status::text not in ('expired', 'missing'), 'notes', c.notes) order by c.started_at desc), '[]')
      from public.calls c left join public.call_outcomes o on o.id = c.outcome_id left join public.profiles p on p.id = c.user_id where c.lead_id = p_lead),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('template_name', w.template_name, 'sent_at', w.sent_at, 'by', coalesce(p.full_name, p.email)) order by w.sent_at desc), '[]')
      from public.wa_messages w left join public.profiles p on p.id = w.user_id where w.lead_id = p_lead and w.undone_at is null));
end $$;

-- "What works": effort behind each sale in the period, my average vs the team's, per person.
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
      select l.id, l.name, l.phone, l.assigned_to, l.won_at, public.lead_effort(l.id) e
      from public.leads l where l.org_id = p_org and l.deleted_at is null and l.won_at >= v_from and l.won_at < v_to
    ), avgs as (
      select (assigned_to = any(v_users)) mine, count(*) n,
        round(avg((e->>'talk_min')::numeric), 1) talk_min, round(avg((e->>'calls')::numeric), 1) calls,
        round(avg((e->>'picked')::numeric), 1) picked, round(avg((e->>'wa')::numeric), 1) wa,
        round(avg((e->>'follow_ups')::numeric), 1) follow_ups, round(avg((e->>'days')::numeric), 1) days,
        round(avg((e->>'calls')::numeric + (e->>'received')::numeric + (e->>'wa')::numeric), 1) interactions
      from won group by rollup ((assigned_to = any(v_users)))
    )
    select jsonb_build_object(
      'mine', (select to_jsonb(a) - 'mine' from avgs a where a.mine is true),
      'team', (select to_jsonb(a) - 'mine' from avgs a where a.mine is null),
      'leads', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'won_at', won_at, 'effort', e) order by won_at desc), '[]')
                from won where assigned_to = any(v_users)),
      'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', assigned_to, 'name', coalesce(p.full_name, p.email), 'sales', n,
                   'talk_min', t, 'calls', c, 'wa', wa, 'days', d, 'follow_ups', fu) order by n desc), '[]') from (
                   select assigned_to, count(*) n, round(avg((e->>'talk_min')::numeric), 1) t, round(avg((e->>'calls')::numeric), 1) c,
                          round(avg((e->>'wa')::numeric), 1) wa, round(avg((e->>'days')::numeric), 1) d, round(avg((e->>'follow_ups')::numeric), 1) fu
                   from won where assigned_to = any(v_users) group by assigned_to) x left join public.profiles p on p.id = x.assigned_to)
    ));
end $$;

-- What converts, by lead type, and how fast leads are first called.
create or replace function public.conversion_insights(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  if not public.is_org_manager(p_org) then raise exception 'Managers only'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  return (with l as (
      select l.*, pc.name cat, (select max(watch_minutes) from public.batch_leads b where b.lead_id = l.id) watch,
        extract(epoch from (l.first_dialled_at - l.created_at)) / 60 first_min
      from public.leads l left join public.profession_categories pc on pc.id = l.profession_category_id
      where l.org_id = p_org and l.deleted_at is null
        and l.created_at >= (p_from::timestamp at time zone v_tz) and l.created_at < ((p_to + 1)::timestamp at time zone v_tz)
    ), g as (
      select 'source' dim, coalesce(nullif(source, ''), '—') k, * from l
      union all select 'category', coalesce(cat, 'No group'), * from l
      union all select 'watch', case when watch is null then 'No webinar' when watch = 0 then 'Did not join' when watch < 30 then '1–29 min' when watch < 60 then '30–59 min' else '60+ min' end, * from l
      union all select 'city', coalesce(nullif(city, ''), '—'), * from l
      union all select 'speed', case when first_min is null then 'Never called' when first_min <= 5 then 'Within 5 min' when first_min <= 60 then '5–60 min'
                                     when first_min <= 1440 then '1–24 hours' else 'After a day' end, * from l
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
              from l where assigned_to is not null group by assigned_to) y left join public.profiles p on p.id = y.assigned_to)
    ));
end $$;

-- Today's focus: every lead of mine that needs attention today, most important first.
create or replace function public.my_focus_list(p_org uuid, p_limit int default 200, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
          when m.score >= 40 then 4 else 5 end bucket,
        case when m.next_follow_up_at < now() then 'Overdue follow-up' when m.next_follow_up_at < now() + interval '2 hours' then 'Follow-up due'
             when m.dial_count = 0 then 'New — not called yet' when m.score >= 40 then '🔥 Close to converting' else null end reason
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
end $$;
