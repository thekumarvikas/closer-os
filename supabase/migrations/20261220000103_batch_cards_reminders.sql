-- Webinar cards: live reminder-call status (leads called / left / talked before the start, per caller).
drop function if exists public.batch_cards(uuid);
create function public.batch_cards(p_org uuid)
returns table(id uuid, name text, kind text, webinar_at timestamptz, auto_created boolean, zoom_uploaded boolean,
  registered int, assigned int, unassigned int, called int, attended int, hot int, repeats int,
  rem_called int, rem_talked int, rem_calls int, rem_by jsonb)
language sql stable security definer set search_path = '' as $$
  with rc as (
    select c.batch_id, c.lead_id, c.user_id, c.duration_sec from public.calls c
    join public.batches b on b.id = c.batch_id
    where c.org_id = p_org and c.purpose = 'reminder' and not b.is_archived and c.started_at < b.webinar_at
  ), per as (
    select batch_id, user_id, count(distinct lead_id) leads, count(*) calls,
      count(distinct lead_id) filter (where duration_sec > 30) talked from rc group by 1, 2
  )
  select b.id, b.name, b.kind, b.webinar_at, b.auto_created, b.zoom_uploaded_at is not null,
    count(l.id)::int,
    count(l.id) filter (where l.assigned_to is not null)::int,
    count(l.id) filter (where l.assigned_to is null)::int,
    count(l.id) filter (where coalesce(l.dial_count, 0) > 0)::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) > 0 or coalesce(bl.attended, false))::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) >= b.hot_minutes or coalesce(bl.warmth, 0) >= 70)::int,
    count(l.id) filter (where bl.is_repeat)::int,
    count(l.id) filter (where exists (select 1 from rc where rc.batch_id = b.id and rc.lead_id = l.id))::int,
    count(l.id) filter (where exists (select 1 from rc where rc.batch_id = b.id and rc.lead_id = l.id and rc.duration_sec > 30))::int,
    (select count(*) from rc where rc.batch_id = b.id)::int,
    coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'leads', p.leads, 'calls', p.calls, 'talked', p.talked) order by p.leads desc)
      from per p where p.batch_id = b.id), '[]')
  from public.batches b
  left join public.batch_leads bl on bl.batch_id = b.id and not coalesce(bl.is_holdout, false)
  left join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  where b.org_id = p_org and not b.is_archived and public.is_org_manager(p_org)
  group by b.id
  order by b.webinar_at desc
$$;
grant execute on function public.batch_cards(uuid) to authenticated;
