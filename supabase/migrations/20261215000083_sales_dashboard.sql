-- One Sales page (Overview · Buyers) + Training library.
-- sales_dashboard(): everything the page shows for a period and filters, in one call.
-- p: {users: [uuid], product, webinar (batch id), enrol (batch label), channel webinar|team, source (lead source)}
create or replace function public.sales_dashboard(p_org uuid, p_from timestamptz, p_to timestamptz, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare mgr boolean := public.is_org_manager(p_org); v_users uuid[]; g numeric := public.org_gst_pct(p_org); tz text; res jsonb;
  f_users uuid[]; f_prod text := nullif(lower(trim(p->>'product')), ''); f_web uuid := nullif(p->>'webinar', '')::uuid;
  f_enrol text := nullif(trim(p->>'enrol'), ''); f_ch text := nullif(p->>'channel', ''); f_src text := nullif(lower(trim(p->>'source')), '');
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into tz from public.organizations where id = p_org;
  v_users := case when mgr then public.ba_users(p_org) else array[auth.uid()] end;
  select array_agg(x::uuid) into f_users from jsonb_array_elements_text(coalesce(p->'users', '[]'::jsonb)) x;
  with base as (
    select s.* from public.sales s left join public.leads l on l.id = s.lead_id
    where s.org_id = p_org and s.status = 'verified' and s.sold_at >= p_from and s.sold_at < p_to
      and (v_users is null or s.credited_to = any(v_users) or (mgr and l.assigned_to = any(v_users)) or (not mgr and s.claimed_by = auth.uid()))
      and (f_users is null or s.credited_to = any(f_users))
      and (f_prod is null or lower(regexp_replace(trim(coalesce(s.product, '')), '\s+', ' ', 'g')) = f_prod)
      and (f_enrol is null or s.enrol_batch = f_enrol)
      and (f_ch is null or coalesce(s.sale_channel, 'team') = f_ch)
      and (f_src is null or lower(coalesce(l.source, '')) = f_src)
  ), pay as (
    select b.id, coalesce(sum(pm.amount) filter (where pm.kind = 'payment'), 0) paid, coalesce(sum(pm.amount) filter (where pm.kind = 'refund'), 0) refunded,
      min(pm.paid_at) filter (where pm.kind = 'payment') first_pay,
      count(*) filter (where pm.removed_at is not null) removed
    from base b left join public.sale_payments pm on pm.sale_id = b.id group by b.id
  ), fullp as (
    -- The payment that completed the order.
    select id, min(paid_at) full_at from (
      select b.id, pm.paid_at, sum(pm.amount) over (partition by b.id order by pm.paid_at, pm.created_at) run, b.amount
      from base b join public.sale_payments pm on pm.sale_id = b.id and pm.kind = 'payment') x
    where run >= amount and amount > 0 group by id
  ), web as (
    -- Webinar the sale came from: set on the sale, else the last one they attended before paying.
    select b.id, coalesce(b.webinar_batch_id, la.batch_id) wid, coalesce(wb.webinar_at, la.webinar_at, (b.webinar_on + time '12:00') at time zone tz) wat,
      coalesce(wb.name, la.name, case when b.webinar_on is not null then 'Webinar · ' || to_char(b.webinar_on, 'FMDD Mon YYYY') end) wname
    from base b
    left join public.batches wb on wb.id = b.webinar_batch_id
    left join lateral (select bl.batch_id, x.webinar_at, x.name from public.batch_leads bl join public.batches x on x.id = bl.batch_id
      where b.webinar_batch_id is null and b.webinar_on is null and bl.lead_id = b.lead_id and x.webinar_at <= b.sold_at and coalesce(bl.watch_minutes, 0) > 0
      order by x.webinar_at desc limit 1) la on true
  ), eff as (
    select b.id, count(c.id) calls,
      count(c.id) filter (where c.duration_sec > 0 and (c.direction = 'incoming' or public.is_real_pickup(c.direction, c.duration_sec, o.category))) convs,
      coalesce(sum(c.duration_sec), 0) talk,
      count(c.id) filter (where c.recording_status = 'uploaded') recs
    from base b left join public.calls c on c.lead_id = b.lead_id and c.started_at <= b.sold_at + interval '1 day'
      left join public.call_outcomes o on o.id = c.outcome_id
    group by b.id
  ), wa as (
    select b.id, count(w.id) wa from base b left join public.wa_messages w on w.lead_id = b.lead_id and w.undone_at is null and w.sent_at <= b.sold_at + interval '1 day' group by b.id
  ), sx as (
    select b.id, b.lead_id, b.product, b.amount, b.sold_at, b.credited_to, b.source, b.enrol_batch, coalesce(b.sale_channel, case when b.credited_to is null then 'none' else 'team' end) channel,
      b.note, b.country, coalesce(l.name, b.buyer->>'name', '') name, coalesce(l.phone, b.buyer->>'phone', '') phone, l.source lead_source, l.city, l.profession,
      coalesce(l.signup_at, l.created_at) signup_at, pay.paid, pay.refunded, pay.removed,
      greatest(b.amount - pay.refunded, 0) net, round(greatest(b.amount - pay.refunded, 0) / (1 + g / 100.0), 2) revenue,
      pay.paid - pay.refunded collected, greatest(b.amount - pay.paid + pay.refunded, 0) pending,
      case when pay.refunded > 0 and pay.refunded >= pay.paid then 'refunded' when pay.paid - pay.refunded >= b.amount and b.amount > 0 then 'full' when pay.paid > 0 then 'part' else 'unpaid' end pay_status,
      fullp.full_at, pay.first_pay, web.wid, web.wat, web.wname,
      round((extract(epoch from coalesce(fullp.full_at, pay.first_pay, b.sold_at) - coalesce(l.signup_at, l.created_at)) / 86400.0)::numeric, 1) days_signup,
      round((extract(epoch from coalesce(fullp.full_at, pay.first_pay, b.sold_at) - web.wat) / 86400.0)::numeric, 1) days_webinar,
      eff.calls, eff.convs, eff.talk, eff.recs, wa.wa
    from base b left join public.leads l on l.id = b.lead_id
      join pay on pay.id = b.id left join fullp on fullp.id = b.id left join web on web.id = b.id
      left join eff on eff.id = b.id left join wa on wa.id = b.id
    where f_web is null or web.wid = f_web
  )
  select jsonb_build_object(
    'gst_pct', g,
    'tiles', (select jsonb_build_object('sales', count(*), 'order_value', coalesce(sum(net), 0), 'revenue', coalesce(sum(revenue), 0),
        'collected', coalesce(sum(collected), 0), 'pending', coalesce(sum(pending), 0), 'pending_orders', count(*) filter (where pending > 0),
        'refunded', coalesce(sum(refunded), 0), 'full', count(*) filter (where pay_status = 'full'), 'part', count(*) filter (where pay_status = 'part'),
        'avg_sale', round(coalesce(avg(revenue), 0), 0),
        'days_signup', round((percentile_cont(0.5) within group (order by days_signup) filter (where days_signup >= 0 and pay_status = 'full'))::numeric, 1),
        'days_webinar', round((percentile_cont(0.5) within group (order by days_webinar) filter (where days_webinar >= 0 and pay_status = 'full'))::numeric, 1),
        'removed', coalesce(sum(removed), 0)) from sx),
    'by_member', coalesce((select jsonb_agg(x order by (x->>'revenue')::numeric desc) from (
      select jsonb_build_object('user_id', credited_to, 'sales', count(*), 'revenue', sum(revenue), 'collected', sum(collected), 'pending', sum(pending),
        'avg_sale', round(avg(revenue), 0), 'calls', round(avg(calls), 1), 'convs', round(avg(convs), 1), 'talk_min', round(avg(talk) / 60.0, 0), 'wa', round(avg(wa), 1),
        'days', round((percentile_cont(0.5) within group (order by days_signup) filter (where days_signup >= 0))::numeric, 1)) x
      from sx group by credited_to) t), '[]'::jsonb),
    'by_webinar', coalesce((select jsonb_agg(x order by (x->>'revenue')::numeric desc) from (
      select jsonb_build_object('id', wid, 'name', coalesce(max(wname), 'No webinar'), 'at', max(wat), 'sales', count(*), 'revenue', sum(revenue), 'collected', sum(collected),
        'direct', count(*) filter (where channel = 'webinar'), 'team', count(*) filter (where channel = 'team'),
        'registered', (select count(*) from public.batch_leads bl where bl.batch_id = wid),
        'attended', (select count(*) from public.batch_leads bl where bl.batch_id = wid and coalesce(bl.watch_minutes, 0) > 0),
        'days', round((percentile_cont(0.5) within group (order by days_webinar) filter (where days_webinar >= 0))::numeric, 1)) x
      from sx group by wid, case when wid is null then wname end) t), '[]'::jsonb),
    'by_product', coalesce((select jsonb_agg(x order by (x->>'revenue')::numeric desc) from (
      select jsonb_build_object('product', coalesce(nullif(trim(product), ''), 'Not named'), 'sales', count(*), 'revenue', sum(revenue), 'collected', sum(collected), 'pending', sum(pending)) x
      from sx group by coalesce(nullif(trim(product), ''), 'Not named')) t), '[]'::jsonb),
    'by_enrol', coalesce((select jsonb_agg(x order by x->>'batch' desc) from (
      select jsonb_build_object('batch', enrol_batch, 'sales', count(*), 'revenue', sum(revenue), 'collected', sum(collected), 'pending', sum(pending)) x
      from sx where enrol_batch is not null group by enrol_batch) t), '[]'::jsonb),
    'by_channel', coalesce((select jsonb_agg(jsonb_build_object('channel', channel, 'sales', n, 'revenue', rev)) from (
      select channel, count(*) n, sum(revenue) rev from sx group by channel) t), '[]'::jsonb),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'sales', n, 'revenue', rev) order by d) from (
      select (sold_at at time zone tz)::date d, count(*) n, sum(revenue) rev from sx group by 1) t), '[]'::jsonb),
    'buyers', coalesce((select jsonb_agg(to_jsonb(r) order by r.sold_at desc) from (select * from sx order by sold_at desc limit 1000) r), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(distinct regexp_replace(trim(product), '\s+', ' ', 'g')) from public.sales where org_id = p_org and status = 'verified' and coalesce(trim(product), '') <> ''), '[]'::jsonb),
    'enrols', coalesce((select jsonb_agg(distinct enrol_batch) from public.sales where org_id = p_org and enrol_batch is not null), '[]'::jsonb),
    'to_verify', (select count(*) from public.sales s where s.org_id = p_org and s.status = 'claimed'
      and (mgr or s.claimed_by = auth.uid() or s.credited_to = auth.uid()))
  ) into res;
  return res;
end $$;

-- "Missed money" for the Sales page: balance still due, and people who look like buyers but haven't bought.
create or replace function public.sales_missed(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[];
begin
  if not public.is_org_manager(p_org) then return '{}'::jsonb; end if;
  v_users := public.ba_users(p_org);
  return (with cand as (
      select bl.lead_id, max(bl.warmth) warmth, max(bl.watch_minutes) mins, bool_or(coalesce(bl.saw_pitch, false)) pitch, max(b.webinar_at) wat
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id join public.leads l on l.id = bl.lead_id
      where b.org_id = p_org and b.webinar_at >= p_from and b.webinar_at < p_to and l.deleted_at is null and not coalesce(l.do_not_call, false)
        and (v_users is null or l.assigned_to = any(v_users))
        and not exists (select 1 from public.sales s where s.lead_id = bl.lead_id and s.status = 'verified')
      group by bl.lead_id
    )
    select jsonb_build_object(
      'hot', coalesce((select jsonb_agg(lead_id) from (select lead_id from cand where warmth >= 70 or pitch order by warmth desc nulls last limit 500) t), '[]'::jsonb),
      'no_call', coalesce((select jsonb_agg(c.lead_id) from (select c.lead_id from cand c where c.mins > 0
          and not exists (select 1 from public.calls k where k.lead_id = c.lead_id and k.started_at > c.wat) order by c.mins desc limit 500) c), '[]'::jsonb),
      'no_talk', coalesce((select jsonb_agg(c.lead_id) from (select c.lead_id from cand c where c.mins > 0
          and exists (select 1 from public.calls k where k.lead_id = c.lead_id and k.started_at > c.wat)
          and not exists (select 1 from public.calls k where k.lead_id = c.lead_id and k.started_at > c.wat and k.duration_sec >= 20) order by c.mins desc limit 500) c), '[]'::jsonb)));
end $$;

-- "What buyers have in common": for leads that signed up in the period, how often each thing is true for buyers vs everyone else.
-- Returns [{key, label, buyers, buyers_total, others, others_total}], strongest difference first.
create or replace function public.buyers_common(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; hot int; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers'; end if;
  v_users := public.ba_users(p_org);
  with co as (
    select l.id, l.source, l.city, l.profession_category_id cat, l.response_sec, l.first_dialled_at, l.signup_at, l.created_at,
      coalesce(l.conversation_count, 0) convs, coalesce(l.total_talk_sec, 0) talk, coalesce(l.call_count, 0) calls, coalesce(l.wa_count, 0) wa,
      coalesce(l.arrivals, 1) arrivals, l.first_talk_dial, l.email, l.profession, l.best_hour,
      exists (select 1 from public.sales s where s.lead_id = l.id and s.status = 'verified') buyer
    from public.leads l
    where l.org_id = p_org and l.deleted_at is null and coalesce(l.source, '') <> 'Phone call'
      and coalesce(l.signup_at, l.created_at) >= p_from and coalesce(l.signup_at, l.created_at) < p_to
      and (v_users is null or l.assigned_to = any(v_users) or l.assigned_to is null)
  ), w as (
    select bl.lead_id, max(coalesce(bl.watch_minutes, 0)) mins, bool_or(coalesce(bl.saw_pitch, false)) pitch, sum(coalesce(bl.chat_count, 0)) chats,
      sum(coalesce(bl.poll_answered, 0)) polls, count(*) filter (where coalesce(bl.watch_minutes, 0) > 0) attended_n, max(coalesce(bl.warmth, 0)) warmth,
      bool_or(coalesce(bl.watch_minutes, 0) >= b.hot_minutes) hot
    from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id in (select id from co) group by bl.lead_id
  ), fu as (
    select f.lead_id, count(*) n, count(*) filter (where f.dialled_at is not null and f.dialled_at <= f.due_at + interval '15 minutes') on_time
    from public.follow_ups f where f.lead_id in (select id from co) group by f.lead_id
  ), t as (
    select co.*, coalesce(w.mins, 0) mins, coalesce(w.pitch, false) pitch, coalesce(w.chats, 0) chats, coalesce(w.polls, 0) polls, coalesce(w.attended_n, 0) attended_n,
      coalesce(w.warmth, 0) warmth, coalesce(w.hot, false) hot, coalesce(fu.n, 0) fus, coalesce(fu.on_time, 0) fu_on_time
    from co left join w on w.lead_id = co.id left join fu on fu.lead_id = co.id
  ), topcat as (select cat from t where buyer and cat is not null group by cat order by count(*) desc limit 1),
     topcity as (select lower(city) city from t where buyer and coalesce(city, '') <> '' group by lower(city) order by count(*) desc limit 1),
     topsrc as (select source from t where buyer and coalesce(source, '') <> '' group by source order by count(*) desc limit 1),
  facts as (
    select k, label, count(*) filter (where buyer and v) b, count(*) filter (where buyer) bt, count(*) filter (where not buyer and v) o, count(*) filter (where not buyer) ot
    from t, lateral (values
      ('attended', 'attended a webinar', t.mins > 0),
      ('hot', 'watched long enough to be a hot lead', t.hot),
      ('watch30', 'watched 30+ minutes', t.mins >= 30),
      ('pitch', 'saw the pitch', t.pitch),
      ('chat', 'wrote in the webinar chat', t.chats > 0),
      ('polls', 'answered a poll', t.polls > 0),
      ('warm', 'had a webinar warmth of 70+', t.warmth >= 70),
      ('attended2', 'attended 2 or more webinars', t.attended_n >= 2),
      ('repeat', 'signed up more than once', t.arrivals > 1),
      ('fast15', 'were called within 15 working minutes of signing up', t.response_sec is not null and t.response_sec <= 900),
      ('fast60', 'were called within 1 working hour', t.response_sec is not null and t.response_sec <= 3600),
      ('sameday', 'were called on the day they signed up', t.first_dialled_at is not null and t.first_dialled_at < coalesce(t.signup_at, t.created_at) + interval '1 day'),
      ('called', 'were called at least once', t.calls > 0),
      ('calls3', 'got 3 or more calls', t.calls >= 3),
      ('calls6', 'got 6 or more calls', t.calls >= 6),
      ('conv', 'had a real conversation', t.convs > 0),
      ('conv2', 'had 2 or more conversations', t.convs >= 2),
      ('talk5', 'talked 5+ minutes in total', t.talk >= 300),
      ('talk15', 'talked 15+ minutes in total', t.talk >= 900),
      ('firstpick', 'picked up the very first call', t.first_talk_dial = 1),
      ('wa', 'got a WhatsApp message from the team', t.wa > 0),
      ('wa3', 'got 3 or more WhatsApp messages', t.wa >= 3),
      ('fu', 'had a follow-up call planned', t.fus > 0),
      ('fu_on_time', 'had a follow-up called on time', t.fu_on_time > 0),
      ('topcat', 'are in the profession group "' || coalesce((select pc.name from public.profession_categories pc where pc.id = (select cat from topcat)), '') || '"', t.cat = (select cat from topcat)),
      ('topcity', 'are from ' || coalesce(initcap((select city from topcity)), ''), lower(t.city) = (select city from topcity)),
      ('topsrc', 'came from "' || coalesce((select source from topsrc), '') || '"', t.source = (select source from topsrc))
    ) x(k, label, v)
    group by k, label
  )
  select jsonb_build_object(
    'cohort', (select count(*) from t), 'buyers', (select count(*) from t where buyer),
    'facts', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'label', label, 'buyers', b, 'buyers_total', bt, 'others', o, 'others_total', ot)
        order by abs(b::numeric / nullif(bt, 0) - o::numeric / nullif(ot, 0)) desc nulls last)
      from facts where bt > 0 and label not like '%""%' and label <> 'are from '), '[]'::jsonb))
  into res;
  return res;
end $$;

-- Training library: every converted sale with its recorded calls (managers; reps see their own sales).
-- p: {product, user, webinar, min_sec (shortest call, default 60)}
create or replace function public.training_library(p_org uuid, p_from timestamptz, p_to timestamptz, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare mgr boolean := public.is_org_manager(p_org); v_users uuid[]; f_prod text := nullif(lower(trim(p->>'product')), ''); f_user uuid := nullif(p->>'user', '')::uuid;
  f_web uuid := nullif(p->>'webinar', '')::uuid; v_min int := coalesce(nullif(p->>'min_sec', '')::int, 60);
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := case when mgr then public.ba_users(p_org) else array[auth.uid()] end;
  return coalesce((select jsonb_agg(x order by (x->>'sold_at') desc) from (
    select jsonb_build_object('sale_id', s.id, 'lead_id', s.lead_id, 'name', coalesce(l.name, s.buyer->>'name', ''), 'product', s.product, 'amount', s.amount,
      'sold_at', s.sold_at, 'credited_to', s.credited_to, 'profession', l.profession, 'city', l.city, 'source', l.source,
      'days', round((extract(epoch from s.sold_at - coalesce(l.signup_at, l.created_at)) / 86400.0)::numeric, 1),
      'webinar', (select b.name from public.batches b where b.id = s.webinar_batch_id),
      'talk_sec', (select coalesce(sum(c.duration_sec), 0) from public.calls c where c.lead_id = s.lead_id and c.started_at <= s.sold_at + interval '1 day'),
      'calls', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'started_at', c.started_at, 'duration_sec', c.duration_sec, 'user_id', c.user_id,
          'direction', c.direction, 'recording_path', c.recording_path, 'outcome', o.label, 'notes', c.notes) order by c.started_at), '[]'::jsonb)
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = s.lead_id and c.recording_status = 'uploaded' and c.recording_path is not null and c.duration_sec >= v_min
          and c.started_at <= s.sold_at + interval '1 day')) x
    from public.sales s join public.leads l on l.id = s.lead_id
    where s.org_id = p_org and s.status = 'verified' and s.sold_at >= p_from and s.sold_at < p_to
      and (v_users is null or s.credited_to = any(v_users) or l.assigned_to = any(v_users))
      and (f_prod is null or lower(regexp_replace(trim(coalesce(s.product, '')), '\s+', ' ', 'g')) = f_prod)
      and (f_user is null or s.credited_to = f_user or exists (select 1 from public.calls c where c.lead_id = s.lead_id and c.user_id = f_user and c.recording_status = 'uploaded'))
      and (f_web is null or s.webinar_batch_id = f_web or exists (select 1 from public.batch_leads bl where bl.lead_id = s.lead_id and bl.batch_id = f_web))
      and exists (select 1 from public.calls c where c.lead_id = s.lead_id and c.recording_status = 'uploaded' and c.recording_path is not null
        and c.duration_sec >= v_min and c.started_at <= s.sold_at + interval '1 day')
    limit 300) t), '[]'::jsonb);
end $$;

-- Payments whose row was removed from the buyers sheet (the manager keeps or deletes each).
create or replace function public.removed_payments(p_org uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'sale_id', p.sale_id, 'amount', p.amount, 'paid_at', p.paid_at, 'removed_at', p.removed_at,
    'name', coalesce(l.name, s.buyer->>'name', ''), 'product', s.product) order by p.removed_at desc), '[]'::jsonb)
  from public.sale_payments p join public.sales s on s.id = p.sale_id left join public.leads l on l.id = s.lead_id
  where p.org_id = p_org and p.removed_at is not null and public.is_org_manager(p_org)
$$;

-- buyer_timeline: also for the person credited with the sale, and for buyers not linked to a lead (payments only).
create or replace function public.buyer_timeline(p_sale uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not (public.is_org_manager(s.org_id) or s.credited_to = auth.uid() or s.claimed_by = auth.uid()) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(e order by e->>'at') from (
    select jsonb_build_object('at', coalesce(l.signup_at, l.created_at), 'kind', 'arrived', 'text', 'Signed up' || coalesce(' · ' || nullif(concat_ws(' · ', l.source, l.campaign), ''), '')) e
      from public.leads l where l.id = s.lead_id
    union all
    select jsonb_build_object('at', o.at, 'kind', 'arrived', 'text', 'Came in again' || coalesce(' · ' || nullif(concat_ws(' · ', o.source, o.campaign), ''), ''))
      from public.lead_origins o where o.lead_id = s.lead_id and not o.is_first
    union all
    select jsonb_build_object('at', c.started_at, 'kind', 'call', 'user_id', c.user_id, 'direction', c.direction, 'duration_sec', c.duration_sec,
      'text', coalesce(oc.label, ''), 'note', c.notes, 'id', c.id, 'recording_path', c.recording_path, 'recording_status', c.recording_status)
      from public.calls c left join public.call_outcomes oc on oc.id = c.outcome_id where c.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', w.sent_at, 'kind', 'whatsapp', 'user_id', w.user_id, 'text', coalesce(w.template_name, 'WhatsApp message'))
      from public.wa_messages w where w.lead_id = s.lead_id and w.undone_at is null
    union all
    select jsonb_build_object('at', b.webinar_at, 'kind', 'webinar', 'text', b.name || ': ' || case when bl.watch_minutes is null then 'registered (no attendance data)'
      when bl.watch_minutes > 0 then 'watched ' || bl.watch_minutes || ' min' || case when bl.saw_pitch then ' · saw the pitch' else '' end
        || case when coalesce(bl.chat_count, 0) > 0 then ' · ' || bl.chat_count || ' chat message' || case when bl.chat_count = 1 then '' else 's' end else '' end
        || case when coalesce(bl.poll_answered, 0) > 0 then ' · answered ' || bl.poll_answered || ' poll' || case when bl.poll_answered = 1 then '' else 's' end else '' end
      else 'registered, didn''t join' end)
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', bc.sent_at, 'kind', 'chat', 'text', '"' || left(bc.message, 200) || '"')
      from public.batch_chat bc where bc.lead_id = s.lead_id and bc.sent_at is not null
    union all
    select jsonb_build_object('at', f.due_at, 'kind', 'followup', 'user_id', f.assigned_to, 'text', 'Follow-up planned' || case when f.dialled_at is not null then ' · called' when f.status = 'cancelled' then ' · cancelled' else '' end)
      from public.follow_ups f where f.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', a.created_at, 'kind', 'note', 'user_id', a.user_id, 'text', a.data->>'text') from public.lead_activities a where a.lead_id = s.lead_id and a.kind = 'note'
    union all
    select jsonb_build_object('at', x.sold_at, 'kind', 'sale', 'text', coalesce(x.product, 'Sale') || ' · order value ' || x.amount || coalesce(' · ' || x.enrol_batch, ''))
      from public.sales x where (x.id = s.id or (s.lead_id is not null and x.lead_id = s.lead_id)) and x.status <> 'rejected'
    union all
    select jsonb_build_object('at', pm.paid_at, 'kind', pm.kind, 'text', pm.amount || ' · ' || pm.method || coalesce(' · ' || pm.part_full, '') || coalesce(' · ' || pm.reference, ''))
      from public.sale_payments pm join public.sales x on x.id = pm.sale_id where x.id = s.id or (s.lead_id is not null and x.lead_id = s.lead_id)
  ) t where e->>'at' is not null), '[]'::jsonb);
end $$;

revoke execute on function public.sales_dashboard(uuid, timestamptz, timestamptz, jsonb) from anon, public;
revoke execute on function public.sales_missed(uuid, timestamptz, timestamptz) from anon, public;
revoke execute on function public.buyers_common(uuid, timestamptz, timestamptz) from anon, public;
revoke execute on function public.training_library(uuid, timestamptz, timestamptz, jsonb) from anon, public;
revoke execute on function public.removed_payments(uuid) from anon, public;
grant execute on function public.sales_dashboard(uuid, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function public.sales_missed(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.buyers_common(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.training_library(uuid, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function public.removed_payments(uuid) to authenticated;
