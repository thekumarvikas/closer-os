-- App: webinar / event calling lists. Reps see their reminder list (before the webinar) and their
-- sales list (after it) with everything needed to filter and sort in the app: watch minutes,
-- profession group, attempts, last outcome, next follow-up, bought already.

-- Webinars/events with leads for me (managers: for anyone they can see), recent first.
create or replace function public.my_batches(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; v_mgr boolean; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  v_mgr := public.is_org_manager(p_org);
  select coalesce(jsonb_agg(x order by x->>'webinar_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('id', b.id, 'name', b.name, 'kind', b.kind, 'webinar_at', b.webinar_at, 'hot_minutes', b.hot_minutes,
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

-- One webinar's calling list for the app. p_purpose 'reminder' (test-group leads left out) or 'sales'.
-- p_everyone (managers only): the whole visible team instead of just me.
create or replace function public.batch_call_list(p_batch uuid, p_purpose text, p_everyone boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_hot int; v_at timestamptz; v_users uuid[]; res jsonb;
begin
  select org_id, hot_minutes, webinar_at into v_org, v_hot, v_at from public.batches where id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  if p_purpose not in ('sales', 'reminder') then raise exception 'Unknown list type'; end if;
  v_users := case when p_everyone and public.is_org_manager(v_org) then public.visible_user_ids(v_org) else array[auth.uid()] end;

  with bl as (
    select b.lead_id, b.watch_minutes, b.attended, b.is_repeat, b.added_at, l.*,
      case when p_purpose = 'reminder' then coalesce(b.reminder_by, l.assigned_to) else l.assigned_to end as rep
    from public.batch_leads b
    join public.leads l on l.id = b.lead_id and l.deleted_at is null
    where b.batch_id = p_batch and not (p_purpose = 'reminder' and b.is_holdout)
  ), vis as (
    select * from bl where bl.rep = any(v_users) or (p_everyone and bl.rep is null and public.is_org_manager(v_org))
  ), c as (
    select k.lead_id, count(*)::int as attempts, bool_or(k.duration_sec > 0) as talked, max(k.started_at) as last_called_at,
      (array_agg(k.outcome_id order by k.started_at desc) filter (where k.outcome_id is not null))[1] as last_outcome_id
    from public.calls k
    where k.lead_id in (select vis.lead_id from vis) and k.purpose = p_purpose
      and (k.batch_id = p_batch or (k.batch_id is null and k.started_at >= (select min(added_at) from vis)))
    group by k.lead_id
  ), f as (
    select fu.lead_id, min(fu.due_at) as next_due from public.follow_ups fu
    where fu.lead_id in (select vis.lead_id from vis) and fu.status = 'pending' and fu.purpose = p_purpose
    group by fu.lead_id
  ), buy as (
    select v.lead_id from vis v join public.customers cu on cu.org_id = v_org
      and (cu.phone = v.phone or (v.email is not null and lower(cu.email) = lower(v.email)))
    group by v.lead_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.lead_id, 'org_id', v.org_id, 'name', v.name, 'phone', v.phone, 'email', v.email, 'city', v.city, 'state', v.state,
      'company', v.company, 'profession', v.profession, 'category_id', v.profession_category_id, 'category', pc.name,
      'source', v.source, 'campaign', v.campaign, 'rep', v.rep, 'assigned_to', v.assigned_to, 'do_not_call', v.do_not_call,
      'watch_minutes', v.watch_minutes, 'attended', coalesce(v.watch_minutes, 0) > 0,
      'is_hot', coalesce(v.watch_minutes, 0) >= v_hot and coalesce(v.watch_minutes, 0) > 0,
      'is_repeat', v.is_repeat, 'registered_at', v.added_at,
      'attempts', coalesce(c.attempts, 0), 'talked', coalesce(c.talked, false), 'last_called_at', c.last_called_at,
      'last_outcome_id', coalesce(c.last_outcome_id, v.last_outcome_id), 'next_follow_up_at', f.next_due,
      'bought', buy.lead_id is not null or exists (select 1 from public.calls k2 join public.call_outcomes o on o.id = k2.outcome_id
                                                  where k2.lead_id = v.lead_id and o.category = 'won')
    )), '[]'::jsonb) into res
  from vis v
  left join c on c.lead_id = v.lead_id
  left join f on f.lead_id = v.lead_id
  left join buy on buy.lead_id = v.lead_id
  left join public.profession_categories pc on pc.id = v.profession_category_id;
  return jsonb_build_object('hot_minutes', v_hot, 'webinar_at', v_at, 'leads', res);
end $$;

revoke execute on function public.my_batches(uuid) from anon, public;
revoke execute on function public.batch_call_list(uuid, text, boolean) from anon, public;
grant execute on function public.my_batches(uuid) to authenticated;
grant execute on function public.batch_call_list(uuid, text, boolean) to authenticated;
