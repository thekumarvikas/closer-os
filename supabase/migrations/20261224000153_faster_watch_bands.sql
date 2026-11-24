-- Webinar watch-time groups: buyers check uses indexes, attendee list worked out once (1.7 s -> fast).
create index if not exists customers_org_phone on public.customers (org_id, phone);
create index if not exists customers_org_email on public.customers (org_id, lower(email));
CREATE OR REPLACE FUNCTION public.batch_watch_bands(p_batch uuid, p_scope text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with b as (select id, pitch_minute, zoom_uploaded_at from batches where id = p_batch),
  x as materialized (
    select bl.watch_minutes w, bl.saw_pitch sp, l.dial_count > 0 called, l.has_talked talked,
      (l.won_at is not null or exists (select 1 from customers cu where cu.org_id = l.org_id
         and (cu.phone = l.phone or (l.email is not null and lower(cu.email) = lower(l.email))))) won
    from batch_leads bl join leads l on l.id = bl.lead_id and l.deleted_at is null
    where bl.batch_id = p_batch and (coalesce(p_scope, 'all') = 'all' or (p_scope = 'registered') = bl.registered)
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
$function$
;
