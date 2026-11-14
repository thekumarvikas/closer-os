-- Buyer Analysis 3–5: effort per sale, pattern finder, gaps. Admin / manager only (team managers: their team's leads).
-- Speed is shown both ways: CLOCK minutes (how fast the business reaches a lead after sign-up) and WORKING minutes
-- (working days/hours/holidays from Settings — fair to team members), for the first call AND the first real conversation.

alter table public.leads add column if not exists first_connected_at timestamptz;
alter table public.leads add column if not exists call_work_sec int;      -- sign-up → first call, working seconds
alter table public.leads add column if not exists conn_work_sec int;      -- sign-up → first conversation, working seconds

-- First real conversation: a dialled call that was really picked up, or a received call with talk.
create or replace function public.t_call_first_connected() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cat public.outcome_category;
begin
  if new.lead_id is null or coalesce(new.duration_sec, 0) <= 0 then return new; end if;
  select category into v_cat from public.call_outcomes where id = new.outcome_id;
  if (new.direction = 'outgoing' and public.is_real_pickup(new.direction, new.duration_sec, v_cat)) or new.direction = 'incoming' then
    update public.leads set first_connected_at = new.started_at
    where id = new.lead_id and (first_connected_at is null or first_connected_at > new.started_at);
  end if;
  return new;
end $$;
drop trigger if exists t_call_first_connected on public.calls;
create trigger t_call_first_connected after insert or update of outcome_id, duration_sec, lead_id on public.calls
  for each row execute function public.t_call_first_connected();

-- Working seconds kept with the lead (so reports over thousands of leads stay fast).
create or replace function public.t_lead_work_secs() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.first_dialled_at is distinct from old.first_dialled_at then
    new.call_work_sec := case when new.first_dialled_at is null then null else public.work_seconds(new.org_id, new.created_at, new.first_dialled_at) end;
  end if;
  if new.first_connected_at is distinct from old.first_connected_at then
    new.conn_work_sec := case when new.first_connected_at is null then null else public.work_seconds(new.org_id, new.created_at, new.first_connected_at) end;
  end if;
  return new;
end $$;
drop trigger if exists t_lead_work_secs on public.leads;
create trigger t_lead_work_secs before update of first_dialled_at, first_connected_at on public.leads
  for each row execute function public.t_lead_work_secs();

-- Fill in for existing leads.
update public.leads l set first_connected_at = x.t from (
  select c.lead_id, min(c.started_at) t from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.lead_id is not null and c.duration_sec > 0
    and ((c.direction = 'outgoing' and public.is_real_pickup(c.direction, c.duration_sec, o.category)) or c.direction = 'incoming')
  group by c.lead_id) x where x.lead_id = l.id and l.first_connected_at is null;
update public.leads set call_work_sec = public.work_seconds(org_id, created_at, first_dialled_at) where first_dialled_at is not null and call_work_sec is null;
update public.leads set conn_work_sec = public.work_seconds(org_id, created_at, first_connected_at) where first_connected_at is not null and conn_work_sec is null;

-- Which leads a manager may analyse: owners/admins everything; team managers their team's (assigned or credited).
create or replace function public.ba_users(p_org uuid) returns uuid[] language sql stable security definer set search_path = '' as $$
  select case when public.is_org_admin(p_org) then null else public.visible_user_ids(p_org) end
$$;

-- ───── 3 Effort per sale ─────
-- One row per verified sale linked to a lead (imported buyers and verified claims), with averages and medians.
-- p: {product, closer} filters; dates = payment date.
create or replace function public.buyer_effort(p_org uuid, p_from timestamptz, p_to timestamptz, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; v_prod text := nullif(trim(p->>'product'), ''); v_closer uuid := nullif(p->>'closer', '')::uuid; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see Buyer Analysis'; end if;
  v_users := public.ba_users(p_org);
  with s as (
    select s.id sale_id, s.lead_id, s.product, s.amount, s.sold_at paid_at, s.source, s.credited_to, l.name, l.phone, l.assigned_to,
      l.created_at signup_at, l.first_dialled_at, l.first_connected_at, l.call_work_sec, l.conn_work_sec, l.arrivals, l.source lead_source
    from public.sales s join public.leads l on l.id = s.lead_id
    where s.org_id = p_org and s.status = 'verified' and s.sold_at >= p_from and s.sold_at < p_to
      and (v_prod is null or lower(regexp_replace(trim(coalesce(s.product, '')), '\s+', ' ', 'g')) = lower(v_prod))
      and (v_users is null or l.assigned_to = any(v_users) or s.credited_to = any(v_users))
  ), c as (
    select s.sale_id, count(c.id) calls, count(c.id) filter (where c.direction = 'outgoing') dialled,
      count(c.id) filter (where c.duration_sec > 0 and ((c.direction = 'outgoing' and public.is_real_pickup(c.direction, c.duration_sec, o.category)) or c.direction = 'incoming')) connected,
      coalesce(sum(c.duration_sec) filter (where c.duration_sec > 0), 0) talk_sec,
      coalesce(jsonb_agg(distinct c.user_id) filter (where c.user_id is not null), '[]'::jsonb) closers
    from s left join public.calls c on c.lead_id = s.lead_id and c.started_at <= s.paid_at
      left join public.call_outcomes o on o.id = c.outcome_id
    group by s.sale_id
  ), w as (
    select s.sale_id, coalesce(jsonb_agg(jsonb_build_object('name', b.name, 'at', b.webinar_at, 'watch', bl.watch_minutes, 'saw_pitch', bl.saw_pitch) order by b.webinar_at), '[]'::jsonb) journey,
      coalesce(sum(bl.watch_minutes), 0) watch_total, coalesce(max(bl.watch_minutes), 0) watch_max
    from s left join public.batch_leads bl on bl.lead_id = s.lead_id left join public.batches b on b.id = bl.batch_id and b.webinar_at <= s.paid_at
    where b.id is not null or bl.lead_id is null
    group by s.sale_id
  ), rows as (
    select s.*, c.calls, c.dialled, c.connected, c.talk_sec, c.closers, coalesce(w.journey, '[]'::jsonb) journey, coalesce(w.watch_total, 0) watch_total, coalesce(w.watch_max, 0) watch_max,
      round(extract(epoch from s.first_dialled_at - s.signup_at) / 60.0)::int call_clock_min, round(s.call_work_sec / 60.0)::int call_work_min,
      round(extract(epoch from s.first_connected_at - s.signup_at) / 60.0)::int conn_clock_min, round(s.conn_work_sec / 60.0)::int conn_work_min,
      round(extract(epoch from s.paid_at - s.first_dialled_at) / 86400.0, 1) days_call_to_pay,
      round(extract(epoch from s.paid_at - s.signup_at) / 86400.0, 1) days_signup_to_pay
    from s left join c on c.sale_id = s.sale_id left join w on w.sale_id = s.sale_id
    where v_closer is null or s.credited_to = v_closer or s.assigned_to = v_closer or c.closers ? v_closer::text
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.paid_at desc) from rows r), '[]'::jsonb),
    'stats', (select jsonb_object_agg(k, st) from (select k, jsonb_build_object('avg', round(avg(v)::numeric, 1), 'median', round((percentile_cont(0.5) within group (order by v))::numeric, 1), 'n', count(v)) st
      from rows r, lateral (values ('call_clock_min', r.call_clock_min::numeric), ('call_work_min', r.call_work_min::numeric), ('conn_clock_min', r.conn_clock_min::numeric),
        ('conn_work_min', r.conn_work_min::numeric), ('calls', r.calls::numeric), ('connected', r.connected::numeric), ('talk_min', round(r.talk_sec / 60.0, 1)),
        ('days_call_to_pay', r.days_call_to_pay), ('days_signup_to_pay', r.days_signup_to_pay), ('watch_total', r.watch_total::numeric), ('amount', r.amount)) x(k, v)
      where v is not null group by k) z),
    'products', coalesce((select jsonb_agg(distinct lower(regexp_replace(trim(product), '\s+', ' ', 'g'))) from public.sales where org_id = p_org and status = 'verified' and coalesce(trim(product), '') <> ''), '[]'::jsonb))
  into res;
  return res;
end $$;

-- Everything that happened with one buyer, in order: arrivals, calls, WhatsApp, webinars, notes, sale and payments.
create or replace function public.buyer_timeline(p_sale uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(e order by e->>'at') from (
    select jsonb_build_object('at', o.at, 'kind', 'arrived', 'text', case when o.is_first then 'Signed up' else 'Came in again' end
      || coalesce(' · ' || nullif(concat_ws(' · ', o.source, o.campaign), ''), '')) e from public.lead_origins o where o.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', c.started_at, 'kind', 'call', 'user_id', c.user_id, 'direction', c.direction, 'duration_sec', c.duration_sec,
      'text', coalesce(oc.label, ''), 'note', c.notes, 'id', c.id, 'recording_path', c.recording_path, 'recording_status', c.recording_status)
      from public.calls c left join public.call_outcomes oc on oc.id = c.outcome_id where c.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', w.sent_at, 'kind', 'whatsapp', 'user_id', w.user_id, 'text', coalesce(w.template_name, 'WhatsApp message'))
      from public.wa_messages w where w.lead_id = s.lead_id and w.undone_at is null
    union all
    select jsonb_build_object('at', b.webinar_at, 'kind', 'webinar', 'text', b.name || ': ' || case when bl.watch_minutes is null then 'no attendance data'
      when bl.watch_minutes > 0 then bl.watch_minutes || ' min' || case when bl.saw_pitch then ' · saw the pitch' else '' end else 'didn''t join' end)
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', a.created_at, 'kind', 'note', 'user_id', a.user_id, 'text', a.data->>'text') from public.lead_activities a where a.lead_id = s.lead_id and a.kind = 'note'
    union all
    select jsonb_build_object('at', x.sold_at, 'kind', 'sale', 'text', coalesce(x.product, 'Sale') || ' · ' || x.amount || case when x.id = s.id then ' (this sale)' else '' end)
      from public.sales x where x.lead_id = s.lead_id and x.status <> 'rejected'
    union all
    select jsonb_build_object('at', pm.paid_at, 'kind', pm.kind, 'text', pm.amount || ' · ' || pm.method || coalesce(' · ' || pm.reference, ''))
      from public.sale_payments pm join public.sales x on x.id = pm.sale_id where x.lead_id = s.lead_id
  ) t), '[]'::jsonb);
end $$;

-- ───── 4 Pattern finder ─────
-- Cohort = ALL leads that signed up in the period (not only buyers), so the comparison is real.
-- p: {call_min 10, call_basis working|clock, call_on first_call|first_connected, attend_min 60, paid_days 7, product}
create or replace function public.buyer_patterns(p_org uuid, p_from timestamptz, p_to timestamptz, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; cm int := coalesce((p->>'call_min')::int, 10); am int := coalesce((p->>'attend_min')::int, 60); pd int := coalesce((p->>'paid_days')::int, 7);
  basis text := coalesce(p->>'call_basis', 'working'); call_on text := coalesce(p->>'call_on', 'first_call'); v_prod text := nullif(trim(p->>'product'), ''); res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see Buyer Analysis'; end if;
  v_users := public.ba_users(p_org);
  with l as (
    select l.id, l.created_at, l.assigned_to,
      case when call_on = 'first_connected' then
             case when basis = 'clock' then extract(epoch from l.first_connected_at - l.created_at) else l.conn_work_sec end
           else case when basis = 'clock' then extract(epoch from l.first_dialled_at - l.created_at) else l.call_work_sec end end secs,
      (select min(s.sold_at) from public.sales s where s.lead_id = l.id and s.status = 'verified'
        and (v_prod is null or lower(regexp_replace(trim(coalesce(s.product, '')), '\s+', ' ', 'g')) = lower(v_prod))) paid_at,
      (select max(bl.watch_minutes) from public.batch_leads bl where bl.lead_id = l.id) watch,
      exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and bl.watch_minutes is not null) has_webinar,
      (select count(*) from public.calls c where c.lead_id = l.id) calls, l.total_talk_sec
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and l.created_at >= p_from and l.created_at < p_to and l.source is distinct from 'Phone call'
      and (v_users is null or l.assigned_to = any(v_users))
  ), f as (
    select *, paid_at is not null as bought,
      secs is not null and secs <= cm * 60 as fast,
      case when has_webinar then coalesce(watch, 0) >= am end as attended,
      paid_at is not null and paid_at - created_at <= make_interval(days => pd) as paid_fast
    from l
  ), b as (select * from f where bought)
  select jsonb_build_object(
    'settings', jsonb_build_object('call_min', cm, 'call_basis', basis, 'call_on', call_on, 'attend_min', am, 'paid_days', pd),
    'leads', (select count(*) from f), 'buyers', (select count(*) from b),
    'buyers_meeting', jsonb_build_object(
      'fast', (select count(*) from b where fast), 'attended', (select count(*) from b where attended), 'attended_known', (select count(*) from b where attended is not null),
      'paid_fast', (select count(*) from b where paid_fast), 'all_three', (select count(*) from b where fast and attended and paid_fast)),
    'conversion', jsonb_build_object(
      'fast', jsonb_build_object('leads', (select count(*) from f where fast), 'buyers', (select count(*) from f where fast and bought)),
      'not_fast', jsonb_build_object('leads', (select count(*) from f where not fast), 'buyers', (select count(*) from f where not fast and bought)),
      'attended', jsonb_build_object('leads', (select count(*) from f where attended), 'buyers', (select count(*) from f where attended and bought)),
      'not_attended', jsonb_build_object('leads', (select count(*) from f where attended = false), 'buyers', (select count(*) from f where attended = false and bought)),
      'both', jsonb_build_object('leads', (select count(*) from f where fast and attended), 'buyers', (select count(*) from f where fast and attended and bought)),
      'neither', jsonb_build_object('leads', (select count(*) from f where not fast and attended = false), 'buyers', (select count(*) from f where not fast and attended = false and bought))),
    -- Most common path among buyers: which conditions they met, how many calls and how much talk it took.
    'paths', coalesce((select jsonb_agg(x order by (x->>'buyers')::int desc) from (
      select jsonb_build_object('fast', fast, 'attended', attended, 'paid_fast', paid_fast, 'buyers', count(*),
        'median_calls', percentile_cont(0.5) within group (order by calls), 'median_talk_min', round((percentile_cont(0.5) within group (order by total_talk_sec) / 60.0)::numeric, 0),
        'median_days', round((percentile_cont(0.5) within group (order by extract(epoch from paid_at - created_at) / 86400.0))::numeric, 1)) x
      from b group by fast, attended, paid_fast) t), '[]'::jsonb))
  into res;
  return res;
end $$;

-- ───── 5 Gaps ─────
create or replace function public.buyer_gaps(p_org uuid, p_from timestamptz, p_to timestamptz, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; cm int := coalesce((p->>'call_min')::int, 10); am int := coalesce((p->>'attend_min')::int, 60);
  basis text := coalesce(p->>'call_basis', 'working'); call_on text := coalesce(p->>'call_on', 'first_call'); v_tz text; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see Buyer Analysis'; end if;
  v_users := public.ba_users(p_org);
  select timezone into v_tz from public.organizations where id = p_org;
  with l as (
    select l.id, l.name, l.phone, l.created_at, l.assigned_to, l.last_call_at, l.last_outcome_id, l.call_count, l.total_talk_sec, l.first_dialled_at,
      case when call_on = 'first_connected' then
             case when basis = 'clock' then extract(epoch from l.first_connected_at - l.created_at) else l.conn_work_sec end
           else case when basis = 'clock' then extract(epoch from l.first_dialled_at - l.created_at) else l.call_work_sec end end secs,
      round(extract(epoch from l.first_dialled_at - l.created_at) / 60.0)::int call_clock_min, round(l.call_work_sec / 60.0)::int call_work_min,
      (select max(bl.watch_minutes) from public.batch_leads bl where bl.lead_id = l.id) watch,
      exists (select 1 from public.sales s where s.lead_id = l.id and s.status = 'verified') bought
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and l.created_at >= p_from and l.created_at < p_to and l.source is distinct from 'Phone call'
      and (v_users is null or l.assigned_to = any(v_users))
  )
  select jsonb_build_object(
    -- a) look like buyers (called fast + watched long) but haven't paid → follow up
    'pattern_not_paid', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'assigned_to', assigned_to, 'watch', watch,
        'call_clock_min', call_clock_min, 'call_work_min', call_work_min, 'calls', call_count, 'talk_sec', total_talk_sec, 'last_call_at', last_call_at,
        'last_outcome_id', last_outcome_id) order by watch desc nulls last)
      from (select * from l where not bought and secs <= cm * 60 and coalesce(watch, 0) >= am limit 1000) x), '[]'::jsonb),
    -- b) not called within the time limit (or never), by team member and by sign-up day
    'slow_by_member', coalesce((select jsonb_agg(jsonb_build_object('user_id', assigned_to, 'leads', n, 'slow', slow, 'never', never) order by slow + never desc) from (
      select assigned_to, count(*) n, count(*) filter (where secs > cm * 60) as slow, count(*) filter (where secs is null) as never from l group by assigned_to) x), '[]'::jsonb),
    'slow_by_day', coalesce((select jsonb_agg(jsonb_build_object('day', x.day, 'leads', x.n, 'slow', x.slow, 'never', x.never) order by x.day) from (
      select (created_at at time zone v_tz)::date as day, count(*) as n, count(*) filter (where secs > cm * 60) as slow, count(*) filter (where secs is null) as never from l group by 1) x), '[]'::jsonb),
    -- c) bought anyway, despite a slow first call or low attendance
    'bought_despite', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'assigned_to', assigned_to, 'watch', watch,
        'call_clock_min', call_clock_min, 'call_work_min', call_work_min, 'slow', secs is null or secs > cm * 60, 'low_watch', coalesce(watch, 0) < am))
      from l where bought and (secs is null or secs > cm * 60 or coalesce(watch, 0) < am)), '[]'::jsonb),
    -- d) watched a webinar for the time limit or more, but nobody called them after it
    'attended_no_call', coalesce((select jsonb_agg(jsonb_build_object('id', ld.id, 'name', ld.name, 'phone', ld.phone, 'assigned_to', ld.assigned_to,
        'webinar', b.name, 'webinar_at', b.webinar_at, 'watch', bl.watch_minutes) order by b.webinar_at desc)
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id join public.leads ld on ld.id = bl.lead_id and ld.deleted_at is null
      where bl.org_id = p_org and coalesce(bl.watch_minutes, 0) >= am and b.webinar_at >= p_from and b.webinar_at < p_to and b.webinar_at < now()
        and (v_users is null or ld.assigned_to = any(v_users))
        and not exists (select 1 from public.calls c where c.lead_id = ld.id and c.direction = 'outgoing' and c.started_at > b.webinar_at)
        and not exists (select 1 from public.sales s where s.lead_id = ld.id and s.status = 'verified' and s.sold_at <= b.webinar_at + interval '1 day')), '[]'::jsonb))
  into res;
  return res;
end $$;

revoke execute on function public.t_call_first_connected() from anon, public, authenticated;
revoke execute on function public.t_lead_work_secs() from anon, public, authenticated;
revoke execute on function public.ba_users(uuid) from anon, public;
revoke execute on function public.buyer_effort(uuid, timestamptz, timestamptz, jsonb) from anon, public;
revoke execute on function public.buyer_timeline(uuid) from anon, public;
revoke execute on function public.buyer_patterns(uuid, timestamptz, timestamptz, jsonb) from anon, public;
revoke execute on function public.buyer_gaps(uuid, timestamptz, timestamptz, jsonb) from anon, public;
grant execute on function public.buyer_effort(uuid, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function public.buyer_timeline(uuid) to authenticated;
grant execute on function public.buyer_patterns(uuid, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function public.buyer_gaps(uuid, timestamptz, timestamptz, jsonb) to authenticated;
