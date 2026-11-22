-- One registration per webinar (owner, Nov 22): the same person sent twice by the sheet / a webhook / an import for the
-- SAME webinar is one registration. "Repeated ×N" (leads.arrivals) = number of different webinars the person registered for;
-- for leads without webinars = number of different sources. Same-source glitches never add up.
create or replace function public.recount_arrivals(p_lead uuid) returns void language sql security definer set search_path = '' as $$
  update public.leads l set arrivals = greatest(1, coalesce(nullif(
      (select count(distinct batch_id) from public.batch_leads b where b.lead_id = l.id and coalesce(b.registered, true)), 0),
      (select count(distinct coalesce(nullif(o.source, ''), o.kind)) from public.lead_origins o where o.lead_id = l.id), 1))
  where l.id = p_lead and l.arrivals is distinct from greatest(1, coalesce(nullif(
      (select count(distinct batch_id) from public.batch_leads b where b.lead_id = l.id and coalesce(b.registered, true)), 0),
      (select count(distinct coalesce(nullif(o.source, ''), o.kind)) from public.lead_origins o where o.lead_id = l.id), 1));
$$;
revoke all on function public.recount_arrivals(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lead_arrived(p_lead uuid, p_kind text, p_source text, p_campaign text, p_batch uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare l public.leads; v_prefix text; v_phone text; v_email text; d jsonb := coalesce(p_data, '{}'::jsonb); v_from text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return; end if;
  select phone_prefix into v_prefix from public.organizations where id = l.org_id;
  v_phone := public.normalize_phone(d->>'phone', v_prefix);
  v_email := public.clean_email(d->>'email');
  v_from := coalesce(nullif(trim(p_source), ''), initcap(coalesce(p_kind, 'other')));
  insert into public.lead_origins (org_id, lead_id, kind, source, campaign, batch_id, user_id, data)
  values (l.org_id, l.id, coalesce(p_kind, 'other'), nullif(trim(p_source), ''), nullif(trim(p_campaign), ''), p_batch, auth.uid(),
    jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(d->>'name'), ''), 'email', v_email, 'phone', v_phone)));
  update public.leads set  last_arrived_at = now(), updated_at = now(),
    name = case when coalesce(trim(name), '') = '' then coalesce(nullif(trim(d->>'name'), ''), name) else name end,
    email = coalesce(email, v_email),
    city = coalesce(city, nullif(trim(d->>'city'), '')),
    state = coalesce(state, nullif(trim(d->>'state'), '')),
    profession = coalesce(profession, nullif(trim(d->>'profession'), '')),
    company = coalesce(company, nullif(trim(d->>'company'), ''))
  where id = l.id;
  if v_phone is not null and length(v_phone) >= 8 and v_phone <> l.phone
     and public.phone_key(v_phone) is distinct from l.phone_key
     and not exists (select 1 from public.lead_phones where org_id = l.org_id and public.phone_key(phone) = public.phone_key(v_phone)) then
    insert into public.lead_phones (org_id, lead_id, phone, label, source) values (l.org_id, l.id, v_phone, 'Secondary', v_from)
    on conflict do nothing;
  end if;
  if v_email is not null and position('@' in v_email) > 1 and l.email is not null
     and public.email_key(v_email) is distinct from public.email_key(l.email)
     and not exists (select 1 from public.lead_emails where lead_id = l.id and email_key = public.email_key(v_email)) then
    insert into public.lead_emails (org_id, lead_id, email, email_key, label, source)
    values (l.org_id, l.id, v_email, public.email_key(v_email), 'Secondary', v_from) on conflict do nothing;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'repeated', jsonb_strip_nulls(jsonb_build_object('source', nullif(trim(p_source), ''),
    'campaign', nullif(trim(p_campaign), ''), 'batch_id', p_batch, 'via', p_kind)));
  if p_batch is not null and coalesce(p_source, '') <> 'Zoom attendee' then
    update public.batch_leads set registered = true where batch_id = p_batch and lead_id = l.id and not registered;
  end if;
  perform public.recount_arrivals(p_lead);
end $function$

;

-- Webinar registrations added / removed / merged → recount.
create or replace function public.t_bl_arrivals() returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.recount_arrivals(coalesce(new.lead_id, old.lead_id)); return null; end $$;
drop trigger if exists t_bl_arrivals on public.batch_leads;
create trigger t_bl_arrivals after insert or delete or update of lead_id, registered on public.batch_leads
  for each row execute function public.t_bl_arrivals();

-- Fix every existing lead (all clients).
do $$ declare r record; begin
  for r in select id from public.leads where deleted_at is null loop perform public.recount_arrivals(r.id); end loop;
end $$;
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
  for o in select * from public.leads where id = any(p_others) and id <> p_keep and org_id = v_org and deleted_at is null loop
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
