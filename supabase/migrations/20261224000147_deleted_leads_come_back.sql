-- Owner rule (Nov 24 2026): a lead that was DELETED and arrives again (sheet, webhook, import, Zoom, app) is never lost.
-- The new lead is kept (sign-up time from the sheet), the old deleted lead's history is merged into it, and the lead is
-- marked "Was deleted on <date> — came back". Works for every way a lead can be created (AFTER INSERT on leads).

-- merge_leads: under closeros.system it may also fold in DELETED copies (not already merged).
CREATE OR REPLACE FUNCTION public.merge_leads(p_keep uuid, p_others uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k public.leads; o public.leads; v_org uuid; n int := 0;
begin
  select * into k from public.leads where id = p_keep and deleted_at is null;
  if k.id is null then raise exception 'Lead not found'; end if;
  v_org := k.org_id;
  if not (public.is_org_manager(v_org) or current_setting('closeros.system', true) = '1') then raise exception 'Only managers can merge leads'; end if;
  for o in select * from public.leads where id = any(p_others) and id <> p_keep and org_id = v_org
      and (deleted_at is null or (current_setting('closeros.system', true) = '1' and merged_into is null)) loop
    update public.calls set lead_id = k.id where lead_id = o.id;
    update public.follow_ups set lead_id = k.id where lead_id = o.id;
    update public.lead_activities set lead_id = k.id where lead_id = o.id;
    update public.wa_messages set lead_id = k.id where lead_id = o.id;
    update public.wa_scheduled set lead_id = k.id where lead_id = o.id;
    update public.wa_sequence_sends set lead_id = k.id where lead_id = o.id;
    update public.call_requests set lead_id = k.id where lead_id = o.id;
    update public.batch_chat set lead_id = k.id where lead_id = o.id;
    update public.batch_poll_answers set lead_id = k.id where lead_id = o.id;
    update public.lead_source_events set lead_id = k.id where lead_id = o.id;
    update public.lead_origins set lead_id = k.id, is_first = false where lead_id = o.id;
    -- Webinars: keep the better attendance when both were registered.
    update public.batch_leads kb set watch_minutes = greatest(coalesce(kb.watch_minutes, 0), coalesce(ob.watch_minutes, 0)),
      attended = kb.attended or ob.attended, reminder_by = coalesce(kb.reminder_by, ob.reminder_by)
    from public.batch_leads ob where ob.lead_id = o.id and kb.lead_id = k.id and kb.batch_id = ob.batch_id;
    delete from public.batch_leads ob where ob.lead_id = o.id and exists (select 1 from public.batch_leads kb where kb.lead_id = k.id and kb.batch_id = ob.batch_id);
    update public.batch_leads set lead_id = k.id where lead_id = o.id;
    -- Sequences: one live run per sequence; a second live one is stopped.
    update public.wa_sequence_leads s set status = 'stopped' where s.lead_id = o.id and s.status in ('active', 'paused')
      and exists (select 1 from public.wa_sequence_leads x where x.lead_id = k.id and x.sequence_id = s.sequence_id and x.status in ('active', 'paused'));
    update public.wa_sequence_leads set lead_id = k.id where lead_id = o.id;
    insert into public.lead_shares (lead_id, org_id, user_id, shared_by) select k.id, v_org, user_id, shared_by from public.lead_shares where lead_id = o.id on conflict do nothing;
    delete from public.lead_shares where lead_id = o.id;
    update public.lead_phones set lead_id = k.id where lead_id = o.id;
    update public.lead_emails set lead_id = k.id where lead_id = o.id and not exists (select 1 from public.lead_emails e where e.lead_id = k.id and e.email = lead_emails.email);
    if o.email is not null and o.email_key is distinct from k.email_key and k.email is not null then
      insert into public.lead_emails (org_id, lead_id, email, email_key, label, source) values (v_org, k.id, o.email, o.email_key, 'From merged lead', 'merge') on conflict do nothing;
    end if;
    if o.phone_key is distinct from k.phone_key then
      insert into public.lead_phones (org_id, lead_id, phone, label) values (v_org, k.id, o.phone, 'From merged lead') on conflict do nothing;
    end if;
    -- Fill what the kept lead is missing.
    update public.leads set
      name = case when coalesce(trim(name), '') = '' then o.name else name end,
      email = coalesce(email, o.email), city = coalesce(city, o.city), state = coalesce(state, o.state),
      profession = coalesce(profession, o.profession), company = coalesce(company, o.company),
      key_facts = case when coalesce(key_facts, '') = '' then o.key_facts when coalesce(o.key_facts, '') = '' then key_facts else key_facts || ' · ' || o.key_facts end,
      notes = case when coalesce(notes, '') = '' then o.notes when coalesce(o.notes, '') = '' then notes else notes || E'\n' || o.notes end,
      tags = (select array(select distinct unnest(coalesce(tags, '{}') || coalesce(o.tags, '{}')))),
      custom = coalesce(o.custom, '{}'::jsonb) || coalesce(custom, '{}'::jsonb),
      assigned_to = coalesce(assigned_to, o.assigned_to),
      arrivals = arrivals + o.arrivals, last_arrived_at = greatest(last_arrived_at, o.last_arrived_at, o.created_at),
      updated_at = now()
    where id = k.id;
    -- The phone number index only allows one live lead per number: free it first.
    update public.leads set deleted_at = now(), merged_into = k.id, updated_at = now() where id = o.id;
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (v_org, k.id, auth.uid(), 'merged', jsonb_build_object('from', o.id, 'name', o.name, 'phone', o.phone));
    n := n + 1;
  end loop;
  perform public.refresh_lead_stats(k.id);
  perform public.recount_arrivals(k.id);
  perform public.write_audit(v_org, 'leads.merged', 'lead', k.id::text, jsonb_build_object('merged', p_others, 'count', n));
  return jsonb_build_object('merged', n, 'lead_id', k.id);
end $function$

;

alter table public.leads add column if not exists was_deleted_at timestamptz, add column if not exists came_back_at timestamptz,
  add column if not exists delete_kind text;  -- 'zoom_undo' = removed by Undo last upload (not a person's choice)
create index if not exists leads_org_phone_key_deleted on public.leads (org_id, phone_key) where deleted_at is not null and merged_into is null;
create index if not exists leads_org_email_key_deleted on public.leads (org_id, email_key) where deleted_at is not null and merged_into is null and email is not null;

create or replace function public.t_lead_came_back() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_old uuid[]; v_when timestamptz; v_flag boolean;
begin
  if new.deleted_at is not null then return null; end if;
  select array_agg(id), max(deleted_at) filter (where delete_kind is null), bool_or(delete_kind is null) into v_old, v_when, v_flag from (
    select id, deleted_at, delete_kind from public.leads
     where org_id = new.org_id and deleted_at is not null and merged_into is null and id <> new.id
       and ((length(coalesce(new.phone_key, '')) >= 8 and phone_key = new.phone_key) or (new.email_key is not null and email_key = new.email_key))
    union
    select l.id, l.deleted_at, l.delete_kind from public.lead_phones lp join public.leads l on l.id = lp.lead_id
     where lp.org_id = new.org_id and l.deleted_at is not null and l.merged_into is null and l.id <> new.id
       and length(coalesce(new.phone_key, '')) >= 8 and public.phone_key(lp.phone) = new.phone_key
    union
    select l.id, l.deleted_at, l.delete_kind from public.lead_emails le join public.leads l on l.id = le.lead_id
     where le.org_id = new.org_id and l.deleted_at is not null and l.merged_into is null and l.id <> new.id
       and new.email_key is not null and le.email_key = new.email_key) x;
  if v_old is null then return null; end if;
  perform set_config('closeros.system', '1', true);
  perform public.merge_leads(new.id, v_old);
  if not v_flag then return null; end if;   -- only removed by an Undo: just join them back quietly
  update public.leads set was_deleted_at = v_when, came_back_at = now() where id = new.id;
  insert into public.lead_activities (org_id, lead_id, kind, data)
  values (new.org_id, new.id, 'came_back', jsonb_build_object('deleted_at', v_when, 'source', new.source, 'old', v_old));
  return null;
end $$;
drop trigger if exists t_lead_came_back on public.leads;
create trigger t_lead_came_back after insert on public.leads for each row execute function public.t_lead_came_back();

CREATE OR REPLACE FUNCTION public.zoom_upload_undo(p_snapshot uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.zoom_upload_snapshots; v_removed int; v_leads int := 0;
begin
  select * into s from public.zoom_upload_snapshots where id = p_snapshot and undone_at is null and taken_at > now() - interval '24 hours';
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'This upload can no longer be undone'; end if;
  -- leads the upload created (from the Zoom file, never called, only in this webinar) go away again
  with gone as (
    update public.leads l set deleted_at = now(), delete_kind = 'zoom_undo' where l.org_id = s.org_id and l.deleted_at is null and l.created_at >= s.taken_at
      and l.source = 'Zoom attendee' and coalesce(l.call_count, 0) = 0
      and exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and bl.batch_id = s.batch_id)
      and not exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and bl.batch_id <> s.batch_id)
    returning 1) select count(*) into v_leads from gone;
  update public.batches set started_at = (s.batch->>'started_at')::timestamptz, zoom_uploaded_at = (s.batch->>'zoom_uploaded_at')::timestamptz
  where id = s.batch_id;
  delete from public.batch_leads where batch_id = s.batch_id;
  get diagnostics v_removed = row_count;
  insert into public.batch_leads select * from jsonb_populate_recordset(null::public.batch_leads, s.rows) on conflict do nothing;
  update public.zoom_upload_snapshots set undone_at = now() where id = s.id;
  perform public.batch_recompute(s.batch_id);
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
  values (s.org_id, auth.uid(), 'batch.zoom_undone', 'batch', s.batch_id, jsonb_build_object('snapshot', s.id, 'leads_removed', v_leads));
  return jsonb_build_object('ok', true, 'restored', jsonb_array_length(s.rows), 'leads_removed', v_leads);
end $function$
;

-- Leads already live again (re-imported after a delete): fold their deleted copies in the same way, once.
create or replace function public.fold_deleted_twins(p_limit int default 300) returns int
language plpgsql security definer set search_path to '' as $$
declare n record; v_old uuid[]; v_when timestamptz; v_flag boolean; c int := 0;
begin
  perform set_config('closeros.system', '1', true);
  for n in select distinct l.id, l.org_id, l.phone_key, l.email_key, l.source from public.leads l
           join public.leads d on d.org_id = l.org_id and d.deleted_at is not null and d.merged_into is null and d.id <> l.id
            and ((length(coalesce(l.phone_key, '')) >= 8 and d.phone_key = l.phone_key) or (l.email_key is not null and d.email_key = l.email_key))
           where l.deleted_at is null limit p_limit loop
    select array_agg(id), max(deleted_at) filter (where delete_kind is null), bool_or(delete_kind is null) into v_old, v_when, v_flag
      from public.leads where org_id = n.org_id and deleted_at is not null and merged_into is null and id <> n.id
       and ((length(coalesce(n.phone_key, '')) >= 8 and phone_key = n.phone_key) or (n.email_key is not null and email_key = n.email_key));
    continue when v_old is null;
    perform public.merge_leads(n.id, v_old);
    if v_flag then
      update public.leads set was_deleted_at = v_when, came_back_at = coalesce(came_back_at, now()) where id = n.id;
      insert into public.lead_activities (org_id, lead_id, kind, data)
      values (n.org_id, n.id, 'came_back', jsonb_build_object('deleted_at', v_when, 'source', n.source, 'old', v_old, 'backfill', true));
    end if;
    c := c + 1;
  end loop;
  return c;
end $$;
revoke all on function public.fold_deleted_twins(int) from public, anon, authenticated;
