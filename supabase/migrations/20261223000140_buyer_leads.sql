-- Rule: every sale has a lead page. A buyer who matches no lead gets one made from the sale (name, phone, every email),
-- source "Buyers list" (no sign-up time known → left out of days-to-convert). Possible same-person cases ('check') stay for Match.
create or replace function public.sales_fill_gaps(p_org uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare n_lead int; n_web int; n_new int := 0; s record; v_prefix text; v_phone text; v_emails text[]; v_id uuid; v_made boolean;
begin
  n_lead := public.rematch_buyers(p_org);
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  for s in select id, buyer, credited_to from public.sales
           where org_id = p_org and lead_id is null and coalesce(match_how, 'none') = 'none' and status <> 'rejected' and buyer is not null loop
    v_phone := public.normalize_phone(s.buyer->>'phone', v_prefix);
    v_emails := array(select public.clean_email(x) from regexp_split_to_table(coalesce(s.buyer->>'email', ''), '[/,;\s]+') x
                      where position('@' in x) > 1);
    if (v_phone is null or length(v_phone) < 8) and cardinality(v_emails) = 0 then continue; end if;
    v_made := false;
    v_id := public.find_lead(p_org, v_phone, v_emails[1]);
    if v_id is null then
      perform set_config('closeros.skip_distribution', 'on', true);
      insert into public.leads (org_id, name, phone, email, source, assigned_to, custom)
      values (p_org, coalesce(nullif(trim(s.buyer->>'name'), ''), 'Buyer'), coalesce(v_phone, ''), v_emails[1], 'Buyers list', s.credited_to,
              coalesce(s.buyer->'extra', '{}'::jsonb))
      returning id into v_id;
      perform set_config('closeros.skip_distribution', 'off', true);
      insert into public.lead_emails (org_id, lead_id, email, email_key, label, source)
      select p_org, v_id, e, public.email_key(e), 'Secondary', 'Buyers list' from unnest(v_emails[2:]) e on conflict do nothing;
      n_new := n_new + 1; v_made := true;
    end if;
    update public.sales set lead_id = v_id, match_how = case when v_made then 'created' else 'phone' end, updated_at = now() where id = s.id;
  end loop;
  with u as (update public.sales x set webinar_batch_id = null
             where x.org_id = p_org and x.lead_id is not null and (x.webinar_batch_id is null or x.webinar_auto) returning x.webinar_batch_id)
  select count(*) filter (where webinar_batch_id is not null) into n_web from u;
  return jsonb_build_object('linked_leads', n_lead, 'leads_made', n_new, 'with_webinar', n_web);
end $$;
revoke all on function public.sales_fill_gaps(uuid) from public, anon;
CREATE OR REPLACE FUNCTION public.sales_dashboard(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      case when l.source = 'Buyers list' then null else greatest(0, round((extract(epoch from coalesce(fullp.full_at, pay.first_pay, b.sold_at) - coalesce(l.signup_at, l.created_at)) / 86400.0)::numeric, 1)) end days_signup,
      ((coalesce(fullp.full_at, pay.first_pay, b.sold_at) at time zone tz)::date - (web.wat at time zone tz)::date)::numeric days_webinar,
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
        'days_signup_avg', round(avg(days_signup) filter (where days_signup >= 0 and pay_status = 'full'), 1),
        'days_webinar_avg', round(avg(days_webinar) filter (where days_webinar >= 0 and pay_status = 'full'), 1),
        'days_n', count(*) filter (where days_signup >= 0 and pay_status = 'full'), 'days_web_n', count(*) filter (where days_webinar >= 0 and pay_status = 'full'),
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
end $function$;
select public.sales_fill_gaps(org_id) from (select distinct org_id from public.sales) x;
