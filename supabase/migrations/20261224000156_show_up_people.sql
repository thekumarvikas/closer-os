-- Webinar show-up page v2 (owner, Nov 26 2026): one row per registrant across one / last 4 / all webinars that have
-- Zoom data, with what happened before the webinar. The page groups them by any "stayed at least N minutes".
create or replace function public.show_up_people(p_batch uuid, p_range text default 'this')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_org uuid; v_at timestamptz; v_tz text; v_users uuid[]; v_mgr boolean; v_ids uuid[];
begin
  select b.org_id, b.webinar_at, o.timezone into v_org, v_at, v_tz
  from public.batches b join public.organizations o on o.id = b.org_id where b.id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(v_org);
  v_mgr := public.is_org_manager(v_org);
  if coalesce(p_range, 'this') = 'this' then v_ids := array[p_batch];
  else
    select array_agg(id order by webinar_at desc) into v_ids from (
      select b.id, b.webinar_at from public.batches b
      where b.org_id = v_org and not b.is_archived and b.webinar_at <= v_at
        and (b.id = p_batch or exists (select 1 from public.batch_leads x where x.batch_id = b.id and coalesce(x.watch_minutes, 0) > 0))
      order by b.webinar_at desc limit case when p_range = 'last4' then 4 else 10000 end) s;
  end if;
  return jsonb_build_object(
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'webinar_at', b.webinar_at) order by b.webinar_at), '[]')
                from public.batches b where b.id = any(v_ids)),
    'rows', (select coalesce(jsonb_agg(r), '[]') from (
      select bl.batch_id as b, l.id, l.name, l.phone, coalesce(bl.reminder_by, l.assigned_to) as owner,
        coalesce(bl.watch_minutes, 0) as w, coalesce(bl.saw_pitch, false) as sp, coalesce(bl.is_repeat, false) as rep,
        coalesce(l.reg_count, 1) as rc, round(extract(epoch from b.webinar_at - coalesce(l.signup_at, l.created_at)) / 3600) as suh,
        coalesce(nullif(l.source, ''), 'Unknown') as src, l.profession_category_id as pc,
        c.n, c.outn, c.talk, c.longest, c.last_out_h, c.last_talk_hr, c.oc, c.last_by
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id
      join public.leads l on l.id = bl.lead_id and l.deleted_at is null
      left join lateral (
        select count(*)::int as n, count(*) filter (where k.direction = 'outgoing')::int as outn,
          coalesce(sum(k.duration_sec), 0)::int as talk, coalesce(max(k.duration_sec), 0)::int as longest,
          round(extract(epoch from b.webinar_at - max(k.started_at) filter (where k.direction = 'outgoing')) / 360) / 10 as last_out_h,
          extract(hour from (max(k.started_at) filter (where k.duration_sec >= 30)) at time zone v_tz)::int as last_talk_hr,
          (array_agg(k.outcome_id order by k.started_at desc) filter (where k.outcome_id is not null))[1] as oc,
          (array_agg(k.user_id order by k.started_at desc))[1] as last_by
        from public.calls k where k.lead_id = bl.lead_id and k.batch_id = bl.batch_id and k.started_at < b.webinar_at
      ) c on true
      where bl.batch_id = any(v_ids) and bl.registered
        and ((coalesce(bl.reminder_by, l.assigned_to) is null and v_mgr) or coalesce(bl.reminder_by, l.assigned_to) = any(v_users))
    ) r));
end $$;
grant execute on function public.show_up_people(uuid, text) to authenticated;
