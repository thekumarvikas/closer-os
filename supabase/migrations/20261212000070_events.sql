-- Events for the individual app (and managers): add / remove leads to a webinar or event in one call.
-- Uses the same batches / batch_leads tables, so lists, sorting, filters and reports keep working.
create or replace function public.event_set_leads(p_batch uuid, p_leads uuid[], p_add boolean default true)
returns int language plpgsql security definer set search_path = '' as $$
declare v_org uuid; n int;
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null then raise exception 'Event not found'; end if;
  if not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  if p_add then
    insert into public.batch_leads (org_id, batch_id, lead_id)
    select v_org, p_batch, l.id from public.leads l
     where l.id = any(p_leads) and l.org_id = v_org and l.deleted_at is null
       and not exists (select 1 from public.batch_leads b where b.batch_id = p_batch and b.lead_id = l.id);
    get diagnostics n = row_count;
  else
    delete from public.batch_leads where batch_id = p_batch and lead_id = any(p_leads);
    get diagnostics n = row_count;
  end if;
  -- Phones keep a copy of each lead (with its events): make them fetch the change.
  update public.leads set updated_at = now() where id = any(p_leads) and org_id = v_org;
  return n;
end $$;
revoke all on function public.event_set_leads(uuid, uuid[], boolean) from public, anon;
grant execute on function public.event_set_leads(uuid, uuid[], boolean) to authenticated;

-- Every event of the company (also empty ones, any date), newest first, with simple counts.
create or replace function public.my_events(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(x order by x->>'webinar_at' desc) from (
    select jsonb_build_object('id', b.id, 'name', b.name, 'kind', b.kind, 'webinar_at', b.webinar_at, 'hot_minutes', b.hot_minutes,
      'pitch_minute', b.pitch_minute, 'zoom_uploaded', b.zoom_uploaded_at is not null,
      'leads', count(l.id), 'called', count(l.id) filter (where l.dial_count > 0), 'talked', count(l.id) filter (where l.has_talked),
      'sales_all', count(l.id), 'reminder_all', count(l.id), 'sales_mine', count(l.id), 'reminder_mine', count(l.id)) as x
    from public.batches b
    left join public.batch_leads bl on bl.batch_id = b.id
    left join public.leads l on l.id = bl.lead_id and l.deleted_at is null and public.lead_visible(l.id)
    where b.org_id = p_org and not b.is_archived
    group by b.id) t), '[]'::jsonb);
end $$;
grant execute on function public.my_events(uuid) to authenticated;
