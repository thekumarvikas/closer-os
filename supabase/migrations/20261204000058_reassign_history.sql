-- Reassigning leads: the new rep sees the lead's whole history (earlier reps' calls, outcomes,
-- recordings — notes were already visible), reminder calls move too, plus lead utilisation numbers
-- and a bulk "reassign" tool.

-- 1) Calls: also visible to anyone who can see the lead.
drop policy if exists calls_select on public.calls;
create policy calls_select on public.calls for select using (
  public.is_org_member(org_id) and (public.can_see_user(org_id, user_id) or (lead_id is not null and public.lead_visible(lead_id)))
);
-- Recordings follow the same rule.
drop policy if exists recordings_select on storage.objects;
create policy recordings_select on storage.objects for select to authenticated using (
  bucket_id = 'recordings' and exists (
    select 1 from public.calls c
    where c.recording_path = storage.objects.name and public.is_org_member(c.org_id)
      and (public.can_see_user(c.org_id, c.user_id) or (c.lead_id is not null and public.lead_visible(c.lead_id)))
  )
);

-- 2) On reassignment: follow-ups move (as before) and upcoming reminder calls the old rep had move too.
create or replace function public.after_lead_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (new.org_id, new.id, auth.uid(), 'assigned', jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
    if new.assigned_to is not null then
      update public.follow_ups set assigned_to = new.assigned_to
      where lead_id = new.id and status = 'pending';
      if old.assigned_to is not null then
        update public.batch_leads bl set reminder_by = new.assigned_to
        from public.batches b
        where bl.lead_id = new.id and bl.batch_id = b.id and bl.reminder_by = old.assigned_to and b.webinar_at > now();
      end if;
    end if;
  end if;
  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (new.org_id, new.id, auth.uid(), 'stage_changed', jsonb_build_object('from', old.stage_id, 'to', new.stage_id));
  end if;
  return new;
end $$;

-- 3) Lead utilisation per person. Utilised = called at least once (by anyone); not utilised = never called.
-- p_from / p_to (dates, optional) = leads ASSIGNED in that period.
create or replace function public.lead_utilisation(p_org uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; v_tz text; v_mgr boolean;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_mgr := public.is_org_manager(p_org);
  v_users := case when v_mgr then public.visible_user_ids(p_org) else array[auth.uid()] end;
  return (with l as (
      select l.assigned_to u, l.dial_count > 0 used, l.has_talked talked, l.assigned_at
      from public.leads l
      where l.org_id = p_org and l.deleted_at is null
        and (l.assigned_to = any(v_users) or (v_mgr and l.assigned_to is null))
        and (p_from is null or (l.assigned_at at time zone v_tz)::date >= p_from)
        and (p_to is null or (l.assigned_at at time zone v_tz)::date <= p_to)
    )
    select jsonb_build_object(
      'total', jsonb_build_object('assigned', count(*) filter (where u is not null), 'utilised', count(*) filter (where u is not null and used),
                                  'not_utilised', count(*) filter (where u is not null and not used), 'unassigned', count(*) filter (where u is null)),
      'people', (select coalesce(jsonb_agg(x order by (x->>'not_utilised')::int desc, (x->>'assigned')::int desc), '[]') from (
          select jsonb_build_object('user_id', u, 'assigned', count(*), 'utilised', count(*) filter (where used),
            'not_utilised', count(*) filter (where not used), 'talked', count(*) filter (where talked),
            'oldest_waiting', min(assigned_at) filter (where not used)) x
          from l where u is not null group by u) t))
    from l);
end $$;
revoke execute on function public.lead_utilisation(uuid, date, date) from anon, public;
grant execute on function public.lead_utilisation(uuid, date, date) to authenticated;

-- 4) Bulk reassign: leads of one person (null = unassigned) shared out evenly between people.
-- p_scope: 'not_utilised' (never called) | 'not_reached' (called, never talked) | 'all'. History stays on the lead.
create or replace function public.reassign_leads(p_org uuid, p_from uuid, p_scope text, p_to uuid[], p_limit int default null)
returns int language plpgsql security definer set search_path = '' as $$
declare n int; i int := 0; x record;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can reassign leads'; end if;
  if p_from is not null and not public.can_see_user(p_org, p_from) then raise exception 'Not allowed'; end if;
  if p_scope not in ('not_utilised', 'not_reached', 'all') then raise exception 'Unknown choice'; end if;
  n := coalesce(cardinality(p_to), 0);
  if n = 0 then raise exception 'Choose at least one person to receive the leads'; end if;
  if exists (select 1 from unnest(p_to) t(u) where not exists (
      select 1 from public.org_members m where m.org_id = p_org and m.user_id = t.u and m.status = 'active')) then
    raise exception 'Leads can only go to active team members'; end if;
  for x in
    select l.id from public.leads l
    where l.org_id = p_org and l.deleted_at is null and l.assigned_to is not distinct from p_from
      and case p_scope when 'not_utilised' then l.dial_count = 0
                       when 'not_reached' then l.dial_count > 0 and not l.has_talked else true end
    order by l.assigned_at nulls first, l.created_at
    limit p_limit
  loop
    update public.leads set assigned_to = p_to[(i % n) + 1], assigned_at = now()
    where id = x.id and assigned_to is distinct from p_to[(i % n) + 1];
    i := i + 1;
  end loop;
  perform public.write_audit(p_org, 'leads.reassigned', 'user', coalesce(p_from::text, 'unassigned'),
    jsonb_build_object('scope', p_scope, 'to', p_to, 'count', i));
  return i;
end $$;
revoke execute on function public.reassign_leads(uuid, uuid, text, uuid[], int) from anon, public;
grant execute on function public.reassign_leads(uuid, uuid, text, uuid[], int) to authenticated;
