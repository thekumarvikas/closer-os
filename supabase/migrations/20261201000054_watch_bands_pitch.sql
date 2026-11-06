-- Webinar watch-time groups and the pitch.
-- batches.pitch_minute = minute of the webinar when the pitch / payment link was shown.
-- Owner's rule: watched >= pitch_minute minutes = "saw the pitch"; joined but less = "left before the pitch".
alter table public.batches add column if not exists pitch_minute int check (pitch_minute is null or pitch_minute >= 0);

create or replace function public.my_batches(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; v_mgr boolean; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  v_mgr := public.is_org_manager(p_org);
  select coalesce(jsonb_agg(x order by x->>'webinar_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('id', b.id, 'name', b.name, 'kind', b.kind, 'webinar_at', b.webinar_at, 'hot_minutes', b.hot_minutes, 'pitch_minute', b.pitch_minute,
      'zoom_uploaded', b.zoom_uploaded_at is not null,
      'reminder_mine', count(*) filter (where not bl.is_holdout and coalesce(bl.reminder_by, l.assigned_to) = auth.uid()),
      'sales_mine', count(*) filter (where l.assigned_to = auth.uid()),
      'reminder_all', count(*) filter (where v_mgr and not bl.is_holdout and (coalesce(bl.reminder_by, l.assigned_to) = any(v_users) or coalesce(bl.reminder_by, l.assigned_to) is null)),
      'sales_all', count(*) filter (where v_mgr and (l.assigned_to = any(v_users) or l.assigned_to is null)),
      'attended', count(*) filter (where coalesce(bl.watch_minutes, 0) > 0)) as x
    from public.batches b
    join public.batch_leads bl on bl.batch_id = b.id
    join public.leads l on l.id = bl.lead_id and l.deleted_at is null
    where b.org_id = p_org and not b.is_archived and b.webinar_at > now() - interval '120 days'
    group by b.id
  ) t
  where (x->>'reminder_mine')::int + (x->>'sales_mine')::int + (x->>'reminder_all')::int + (x->>'sales_all')::int > 0;
  return res;
end $$;


-- Leads of one webinar grouped by watch time in 10-minute steps (1–10, 11–20, …) and by the pitch.
-- Runs as the caller: everyone only counts the leads they can see.
create or replace function public.batch_watch_bands(p_batch uuid)
returns jsonb language sql stable security invoker set search_path = public as $$
  with b as (select id, pitch_minute, zoom_uploaded_at from batches where id = p_batch),
  x as (
    select bl.watch_minutes w, l.dial_count > 0 called, l.has_talked talked,
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
                when x.w >= b.pitch_minute then 'saw' else 'before' end k,
      count(*) leads, count(*) filter (where called) called, count(*) filter (where talked) talked, count(*) filter (where won) won
    from x, b group by 1
  )
  select jsonb_build_object(
    'pitch_minute', (select pitch_minute from b),
    'zoom_uploaded', (select zoom_uploaded_at is not null from b),
    'bands', coalesce((select jsonb_agg(jsonb_build_object('k', k,
        'from', case when k < 0 then null else k * 10 + 1 end, 'to', case when k < 0 then null else k * 10 + 10 end,
        'leads', leads, 'called', called, 'talked', talked, 'won', won) order by k) from g), '[]'::jsonb),
    'pitch', coalesce((select jsonb_object_agg(k, jsonb_build_object('leads', leads, 'called', called, 'talked', talked, 'won', won)) from p), '{}'::jsonb));
$$;
grant execute on function public.batch_watch_bands(uuid) to authenticated;
