-- Sales, buyer and speed numbers count from the sign-up time (sheet/file), not the time the lead was added.
CREATE OR REPLACE FUNCTION public.buyer_effort(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; v_prod text := nullif(trim(p->>'product'), ''); v_closer uuid := nullif(p->>'closer', '')::uuid; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see Buyer Analysis'; end if;
  v_users := public.ba_users(p_org);
  with s as (
    select s.id sale_id, s.lead_id, s.product, s.amount, s.sold_at paid_at, s.source, s.credited_to, l.name, l.phone, l.assigned_to,
      coalesce(l.signup_at, l.created_at) signup_at, l.first_dialled_at, l.first_connected_at, l.call_work_sec, l.conn_work_sec, l.arrivals, l.source lead_source
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
end $function$;
CREATE OR REPLACE FUNCTION public.buyer_gaps(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; cm int := coalesce((p->>'call_min')::int, 10); am int := coalesce((p->>'attend_min')::int, 60);
  basis text := coalesce(p->>'call_basis', 'working'); call_on text := coalesce(p->>'call_on', 'first_call'); v_tz text; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see Buyer Analysis'; end if;
  v_users := public.ba_users(p_org);
  select timezone into v_tz from public.organizations where id = p_org;
  with l as (
    select l.id, l.name, l.phone, coalesce(l.signup_at, l.created_at) created_at, l.assigned_to, l.last_call_at, l.last_outcome_id, l.call_count, l.total_talk_sec, l.first_dialled_at,
      case when call_on = 'first_connected' then
             case when basis = 'clock' then extract(epoch from l.first_connected_at - coalesce(l.signup_at, l.created_at)) else l.conn_work_sec end
           else case when basis = 'clock' then extract(epoch from l.first_dialled_at - coalesce(l.signup_at, l.created_at)) else l.call_work_sec end end secs,
      round(extract(epoch from l.first_dialled_at - coalesce(l.signup_at, l.created_at)) / 60.0)::int call_clock_min, round(l.call_work_sec / 60.0)::int call_work_min,
      (select max(bl.watch_minutes) from public.batch_leads bl where bl.lead_id = l.id) watch,
      exists (select 1 from public.sales s where s.lead_id = l.id and s.status = 'verified') bought
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and coalesce(l.signup_at, l.created_at) >= p_from and coalesce(l.signup_at, l.created_at) < p_to and l.source is distinct from 'Phone call'
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
end $function$;
CREATE OR REPLACE FUNCTION public.buyer_patterns(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; cm int := coalesce((p->>'call_min')::int, 10); am int := coalesce((p->>'attend_min')::int, 60); pd int := coalesce((p->>'paid_days')::int, 7);
  basis text := coalesce(p->>'call_basis', 'working'); call_on text := coalesce(p->>'call_on', 'first_call'); v_prod text := nullif(trim(p->>'product'), ''); res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see Buyer Analysis'; end if;
  v_users := public.ba_users(p_org);
  with l as (
    select l.id, coalesce(l.signup_at, l.created_at) created_at, l.assigned_to,
      case when call_on = 'first_connected' then
             case when basis = 'clock' then extract(epoch from l.first_connected_at - coalesce(l.signup_at, l.created_at)) else l.conn_work_sec end
           else case when basis = 'clock' then extract(epoch from l.first_dialled_at - coalesce(l.signup_at, l.created_at)) else l.call_work_sec end end secs,
      (select min(s.sold_at) from public.sales s where s.lead_id = l.id and s.status = 'verified'
        and (v_prod is null or lower(regexp_replace(trim(coalesce(s.product, '')), '\s+', ' ', 'g')) = lower(v_prod))) paid_at,
      (select max(bl.watch_minutes) from public.batch_leads bl where bl.lead_id = l.id) watch,
      exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and bl.watch_minutes is not null) has_webinar,
      (select count(*) from public.calls c where c.lead_id = l.id) calls, l.total_talk_sec
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and coalesce(l.signup_at, l.created_at) >= p_from and coalesce(l.signup_at, l.created_at) < p_to and l.source is distinct from 'Phone call'
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
end $function$;
CREATE OR REPLACE FUNCTION public.conversion_insights(p_org uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text;
begin
  if not public.is_org_manager(p_org) then raise exception 'Managers only'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  return (with l as (
      select l.*, pc.name cat, public.lead_revenue(l.id) rev, (select max(watch_minutes) from public.batch_leads b where b.lead_id = l.id) watch,
        -- Only leads that came in by themselves (not added from a call, not bulk imports), in working minutes.
        (l.is_live and coalesce(l.source, '') <> 'Phone call') live,
        case when l.first_dialled_at is null then null
             else greatest(0, coalesce(l.response_sec, extract(epoch from (l.first_dialled_at - coalesce(l.signup_at, l.created_at)))::int)) / 60.0 end first_min
      from public.leads l left join public.profession_categories pc on pc.id = l.profession_category_id
      where l.org_id = p_org and l.deleted_at is null
        and coalesce(l.signup_at, l.created_at) >= (p_from::timestamp at time zone v_tz) and coalesce(l.signup_at, l.created_at) < ((p_to + 1)::timestamp at time zone v_tz)
    ), g as (
      select 'source' dim, coalesce(nullif(source, ''), '—') k, * from l
      union all select 'category', coalesce(cat, 'No group'), * from l
      union all select 'watch', case when watch is null then 'No webinar' when watch = 0 then 'Did not join' when watch < 30 then '1–29 min' when watch < 60 then '30–59 min' else '60+ min' end, * from l
      union all select 'city', coalesce(nullif(city, ''), '—'), * from l
      union all select 'speed', case when first_min is null then 'Never called' when first_min <= 5 then 'Within 5 min' when first_min <= 60 then '5–60 min'
                                     when first_min <= 1440 then '1–24 hours' else 'After a day' end, * from l where live
    )
    select jsonb_build_object(
      'revenue', (select coalesce(sum(rev), 0) from l),
      'leads', (select count(*) from l), 'won', (select count(*) from l where won_at is not null),
      'groups', (select coalesce(jsonb_agg(jsonb_build_object('dim', dim, 'key', k, 'leads', n, 'won', w, 'rate', r, 'talk_min_won', t,
                    'revenue', rv, 'avg_sale', round(rv / nullif(w, 0)), 'rev_per_lead', round(rv / nullif(n, 0))) order by dim, n desc), '[]')
        from (select dim, k, count(*) n, count(*) filter (where won_at is not null) w, coalesce(sum(rev), 0) rv,
                     round(100.0 * count(*) filter (where won_at is not null) / nullif(count(*), 0), 1) r,
                     round(avg(total_talk_sec / 60.0) filter (where won_at is not null), 1) t
              from g group by dim, k) x),
      'speed_by_rep', (select coalesce(jsonb_agg(jsonb_build_object('user_id', assigned_to, 'name', coalesce(p.full_name, p.email),
            'avg_min', a, 'median_min', m, 'never', nv, 'leads', n) order by a nulls last), '[]')
        from (select assigned_to, count(*) n, round(avg(first_min)) a, round(percentile_cont(0.5) within group (order by first_min)) m,
                     count(*) filter (where first_min is null) nv
              from l where assigned_to is not null and live group by assigned_to) y left join public.profiles p on p.id = y.assigned_to)
    ));
end $function$;
CREATE OR REPLACE FUNCTION public.sale_facts(p_sale uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.sales; l public.leads; res jsonb; flags text[] := '{}'; v_talk int; v_calls int; v_price numeric; v_other int; v_assigned boolean;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not (public.is_org_manager(s.org_id) or s.claimed_by = auth.uid()) then raise exception 'Not allowed'; end if;
  select * into l from public.leads where id = s.lead_id;
  select count(*), coalesce(sum(duration_sec) filter (where duration_sec > 0), 0) into v_calls, v_talk
    from public.calls where lead_id = s.lead_id and user_id = s.claimed_by;
  select price into v_price from public.products where id = s.product_id;
  select count(*) into v_other from public.sales where lead_id = s.lead_id and id <> s.id and status <> 'rejected'
    and abs(extract(epoch from (sold_at - s.sold_at))) < 30 * 86400;
  v_assigned := l.id is not null and (l.assigned_to = s.claimed_by or s.claimed_by = any(coalesce(l.shared_with, '{}')));
  if s.source not in ('import', 'backfill') then
    if v_calls = 0 then flags := flags || 'No calls with this lead from the person claiming it'::text;
    elsif v_talk < 60 then flags := flags || ('Only ' || v_talk || ' seconds of talk with this lead');
    end if;
    if l.id is not null and not v_assigned then flags := flags || 'Not their lead (assigned to someone else)'::text; end if;
  end if;
  if v_price is not null and s.amount <> v_price then flags := flags || ('Amount ' || s.amount || ' differs from the price list (' || v_price || ')'); end if;
  if v_other > 0 then flags := flags || ('Another sale for this lead within 30 days (' || v_other || ')'); end if;
  if l.id is not null and l.last_connected_at is not null and s.sold_at - l.last_connected_at > interval '30 days' then
    flags := flags || 'No conversation in the 30 days before the sale'::text;
  end if;

  select jsonb_build_object(
    'sale', to_jsonb(s) || public.sale_money(s.id),
    'lead', case when l.id is null then null else jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source,
      'assigned_to', l.assigned_to, 'created_at', l.created_at, 'signup_at', coalesce(l.signup_at, l.created_at), 'first_dialled_at', l.first_dialled_at, 'calls', l.call_count,
      'conversations', l.conversation_count, 'talk_sec', l.total_talk_sec, 'wa', l.wa_count, 'arrivals', l.arrivals) end,
    'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'calls', n, 'talk_sec', t, 'last', last) order by t desc) from (
        select user_id, count(*) n, coalesce(sum(duration_sec) filter (where duration_sec > 0), 0) t, max(started_at) last
        from public.calls where lead_id = s.lead_id group by user_id) x), '[]'::jsonb),
    'wa', (select count(*) from public.wa_messages w where w.lead_id = s.lead_id and w.undone_at is null),
    'recordings', (select count(*) from public.calls c where c.lead_id = s.lead_id and c.recording_path is not null),
    'calls', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'at', c.started_at, 'user_id', c.user_id, 'direction', c.direction,
        'duration_sec', c.duration_sec, 'outcome', o.label, 'recording_path', c.recording_path, 'recording_status', c.recording_status) order by c.started_at desc)
      from (select * from public.calls where lead_id = s.lead_id order by started_at desc limit 30) c left join public.call_outcomes o on o.id = c.outcome_id), '[]'::jsonb),
    'webinars', coalesce((select jsonb_agg(jsonb_build_object('name', b.name, 'at', b.webinar_at, 'watch', bl.watch_minutes, 'saw_pitch', bl.saw_pitch) order by b.webinar_at)
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = s.lead_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.paid_at) from public.sale_payments p where p.sale_id = s.id), '[]'::jsonb),
    'flags', to_jsonb(flags))
  into res;
  return res;
end $function$;
CREATE OR REPLACE FUNCTION public.lead_start_at(l leads)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when l.assigned_at is not null and l.assigned_at > coalesce(l.signup_at, l.created_at)
              and (l.first_dialled_at is null or l.assigned_at <= l.first_dialled_at) then l.assigned_at else coalesce(l.signup_at, l.created_at) end
$function$;
CREATE OR REPLACE FUNCTION public.t_lead_work_secs()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.first_dialled_at is distinct from old.first_dialled_at or new.signup_at is distinct from old.signup_at then
    new.call_work_sec := case when new.first_dialled_at is null then null else public.work_seconds(new.org_id, coalesce(new.signup_at, new.created_at), new.first_dialled_at) end;
  end if;
  if new.first_connected_at is distinct from old.first_connected_at or new.signup_at is distinct from old.signup_at then
    new.conn_work_sec := case when new.first_connected_at is null then null else public.work_seconds(new.org_id, coalesce(new.signup_at, new.created_at), new.first_connected_at) end;
  end if;
  return new;
end $function$;
drop trigger if exists t_lead_work_secs on public.leads;
create trigger t_lead_work_secs before update of first_dialled_at, first_connected_at, signup_at on public.leads
  for each row execute function public.t_lead_work_secs();
-- Recount for leads whose sign-up time differs from the time they were added.
update public.leads l set
  call_work_sec = case when first_dialled_at is null then null else public.work_seconds(org_id, signup_at, first_dialled_at) end,
  conn_work_sec = case when first_connected_at is null then null else public.work_seconds(org_id, signup_at, first_connected_at) end,
  response_sec = case when first_dialled_at is null then response_sec
                      else public.work_seconds(org_id, public.lead_start_at(l.*), first_dialled_at) end
where signup_at is not null and abs(extract(epoch from signup_at - created_at)) > 60 and first_dialled_at is not null;
