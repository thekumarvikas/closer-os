-- Round 15 · 5) Webinars: registered vs walk-ins, no-shows always marked, "came to an earlier webinar".
--
-- Owner's rules (Nov 17):
--  * Registrants are the people who registered; attendees are the people who attended. It must not matter
--    whether the registration file or the Zoom report is uploaded first.
--  * People who joined without registering for THIS webinar (old registrations, WhatsApp) are their own group:
--    batch_leads.registered = false. Show-up is shown for registrants, for walk-ins, and combined.
--  * The same registration arriving twice (Google Sheet + the exported file) is not "Repeated".
--    is_repeat now means "came to an earlier webinar" (an earlier webinar attended in Closer OS, or the
--    file's "Previous webinar attended date / duration" columns), with prev_at / prev_minutes.
--  * Leads added after the Zoom report are no-shows (0 minutes), not "no Zoom data".

alter table public.batch_leads add column if not exists registered boolean not null default true;
alter table public.batch_leads add column if not exists prev_at timestamptz;
alter table public.batch_leads add column if not exists prev_minutes numeric;

-- ───── Leads that join after the Zoom report was applied didn't attend ─────
create or replace function public.t_bl_noshow() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.watch_minutes is null and exists (select 1 from public.batches b where b.id = new.batch_id and b.zoom_uploaded_at is not null) then
    new.watch_minutes := 0; new.attended := coalesce(new.attended, false);
  end if;
  return new;
end $$;
drop trigger if exists t_bl_noshow on public.batch_leads;
create trigger t_bl_noshow before insert on public.batch_leads for each row execute function public.t_bl_noshow();

-- ───── "Came to an earlier webinar" for the rows just added ─────
create or replace function public.batch_prev_fill(p_batch uuid, p_leads uuid[] default null)
returns void language sql security definer set search_path = '' as $$
  update public.batch_leads bl set prev_at = p.at, prev_minutes = p.mins, is_repeat = p.at is not null
  from (
    select n.lead_id,
      coalesce(e.at, c.at) as at, coalesce(e.mins, c.mins) as mins
    from public.batch_leads n
    join public.batches b on b.id = n.batch_id
    join public.leads l on l.id = n.lead_id
    left join lateral (
      select b2.webinar_at as at, o.watch_minutes::numeric as mins
      from public.batch_leads o join public.batches b2 on b2.id = o.batch_id
      where o.lead_id = n.lead_id and o.batch_id <> n.batch_id and o.attended and b2.webinar_at < b.webinar_at
      order by b2.webinar_at desc limit 1) e on true
    left join lateral (
      select public.parse_any_date(nullif(trim(l.custom->>'previous_webinar_attended_date'), ''), o2.timezone) as at,
             nullif(regexp_replace(coalesce(l.custom->>'previous_webinar_attended_duration', ''), '[^0-9.]', '', 'g'), '')::numeric as mins
      from public.organizations o2 where o2.id = l.org_id) c on true
    where n.batch_id = p_batch and (p_leads is null or n.lead_id = any(p_leads))
  ) p
  where bl.batch_id = p_batch and bl.lead_id = p.lead_id
    and (bl.prev_at is distinct from p.at or bl.prev_minutes is distinct from p.mins or bl.is_repeat is distinct from (p.at is not null));
$$;
revoke execute on function public.batch_prev_fill(uuid, uuid[]) from anon, public, authenticated;

create or replace function public.t_bl_prev() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select batch_id, array_agg(lead_id) ids from new_rows group by batch_id loop
    perform public.batch_prev_fill(r.batch_id, r.ids);
  end loop;
  return null;
end $$;
drop trigger if exists t_bl_prev on public.batch_leads;
create trigger t_bl_prev after insert on public.batch_leads referencing new table as new_rows
  for each statement execute function public.t_bl_prev();

-- ───── Import / arrival / Zoom: who registered ─────
CREATE OR REPLACE FUNCTION public.import_leads(p_org uuid, p_rows jsonb, p_source text DEFAULT NULL::text, p_campaign text DEFAULT NULL::text, p_assign_mode text DEFAULT 'rules'::text, p_assign_to uuid DEFAULT NULL::uuid, p_batch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_prefix text; r jsonb; v_phone text; v_email text; v_ins int := 0; v_dup int := 0; v_bad int := 0; v_joined int := 0;
  v_n int; v_assignee uuid; v_existing uuid; v_new uuid; v_minutes int;
  v_pk text; v_ek text; v_extra boolean;
  -- People added from the Zoom attendance file joined without registering; any other file is a registration list.
  v_reg boolean := coalesce(p_source, '') <> 'Zoom attendee';
  std text[] := array['name','phone','email','country','state','city','timezone','profession','company','source','campaign','notes','deal_value','tags','watch_minutes'];
begin
  if not public.is_org_manager(p_org) then raise exception 'Only admins and managers can import leads'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_assign_mode = 'user' and (p_assign_to is null or not public.can_see_user(p_org, p_assign_to)) then
    raise exception 'Choose someone you manage to assign these leads to';
  end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then
    raise exception 'Unknown webinar batch';
  end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  if p_assign_mode <> 'rules' then perform set_config('closeros.skip_distribution', 'on', true); end if;

  -- Most companies keep no extra numbers; checking once saves two probes per row.
  select exists (select 1 from public.lead_phones where org_id = p_org) into v_extra;

  create temp table if not exists _imp_seen (phone text primary key) on commit drop;
  truncate pg_temp._imp_seen;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    v_email := nullif(lower(trim(r->>'email')), '');
    v_minutes := nullif(regexp_replace(coalesce(r->>'watch_minutes', ''), '[^0-9]', '', 'g'), '')::int;
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;

    -- The same number twice in one file.
    insert into pg_temp._imp_seen (phone) values (v_phone) on conflict do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then v_dup := v_dup + 1; continue; end if;

    -- Same probes as find_lead, run here so there is no SECURITY DEFINER call per row.
    v_pk := public.phone_key(v_phone);
    v_ek := public.email_key(v_email);
    v_existing := null;
    select id into v_existing from public.leads where org_id = p_org and phone = v_phone and deleted_at is null limit 1;
    if v_existing is null and v_extra then
      select lead_id into v_existing from public.lead_phones where org_id = p_org and phone = v_phone limit 1;
    end if;
    if v_existing is null and v_pk is not null and length(v_pk) >= 8 then
      select id into v_existing from public.leads where org_id = p_org and phone_key = v_pk and deleted_at is null order by created_at limit 1;
      if v_existing is null and v_extra then
        select lp.lead_id into v_existing from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null
          where lp.org_id = p_org and public.phone_key(lp.phone) = v_pk limit 1;
      end if;
    end if;
    if v_existing is null and v_ek is not null and position('@' in v_ek) > 1 then
      select id into v_existing from public.leads where org_id = p_org and email_key = v_ek and deleted_at is null order by created_at limit 1;
    end if;

    if v_existing is not null then
      -- Same person again: one lead, with this arrival remembered.
      perform public.lead_arrived(v_existing, 'import', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign), p_batch, r);
      if p_batch is null then v_dup := v_dup + 1; continue; end if;
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended, registered)
      values (p_batch, v_existing, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0, v_reg)
      -- An incoming 0 (a registration file without minutes, after the Zoom report) never wipes real minutes.
      on conflict (batch_id, lead_id) do update set watch_minutes = case when coalesce(excluded.watch_minutes, 0) > 0 then excluded.watch_minutes
                                                                          else coalesce(public.batch_leads.watch_minutes, excluded.watch_minutes) end,
        attended = public.batch_leads.attended or excluded.attended,
        registered = public.batch_leads.registered or excluded.registered;
      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (p_org, v_existing, auth.uid(), 'batch_joined', jsonb_build_object('batch_id', p_batch, 'repeat', true));
      v_joined := v_joined + 1;
      continue;
    end if;

    v_assignee := case p_assign_mode when 'user' then p_assign_to else null end;
    insert into public.leads (org_id, name, phone, email, country, state, city, timezone, profession, company,
                              source, campaign, notes, deal_value, tags, custom, assigned_to)
    values (
      p_org, coalesce(r->>'name', ''), v_phone, v_email, r->>'country', r->>'state', r->>'city', r->>'timezone',
      r->>'profession', r->>'company', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign),
      r->>'notes', nullif(regexp_replace(coalesce(r->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric,
      coalesce(array(select trim(x) from unnest(string_to_array(r->>'tags', ',')) x where trim(x) <> ''), '{}'),
      coalesce(r->'custom', '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(r) as e(k, v) where k <> 'custom' and not k = any(std)), '{}'::jsonb),
      v_assignee
    ) returning id into v_new;
    if p_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended, registered)
      values (p_batch, v_new, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0, v_reg);
    end if;
    v_ins := v_ins + 1;
  end loop;

  perform set_config('closeros.skip_distribution', 'off', true);
  perform public.write_audit(p_org, 'leads.imported', 'lead', null,
    jsonb_build_object('inserted', v_ins, 'joined_batch', v_joined, 'duplicates', v_dup, 'invalid', v_bad, 'source', p_source, 'batch', p_batch));
  return jsonb_build_object('inserted', v_ins, 'joined', v_joined, 'duplicates', v_dup, 'invalid', v_bad);
end $function$;

CREATE OR REPLACE FUNCTION public.lead_arrived(p_lead uuid, p_kind text, p_source text, p_campaign text, p_batch uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare l public.leads; v_prefix text; v_phone text; d jsonb := coalesce(p_data, '{}'::jsonb);
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return; end if;
  select phone_prefix into v_prefix from public.organizations where id = l.org_id;
  v_phone := public.normalize_phone(d->>'phone', v_prefix);
  insert into public.lead_origins (org_id, lead_id, kind, source, campaign, batch_id, user_id, data)
  values (l.org_id, l.id, coalesce(p_kind, 'other'), nullif(trim(p_source), ''), nullif(trim(p_campaign), ''), p_batch, auth.uid(),
    jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(d->>'name'), ''), 'email', public.clean_email(d->>'email'), 'phone', v_phone)));
  update public.leads set arrivals = arrivals + 1, last_arrived_at = now(), updated_at = now(),
    name = case when coalesce(trim(name), '') = '' then coalesce(nullif(trim(d->>'name'), ''), name) else name end,
    email = coalesce(email, public.clean_email(d->>'email')),
    city = coalesce(city, nullif(trim(d->>'city'), '')),
    state = coalesce(state, nullif(trim(d->>'state'), '')),
    profession = coalesce(profession, nullif(trim(d->>'profession'), '')),
    company = coalesce(company, nullif(trim(d->>'company'), ''))
  where id = l.id;
  -- Same person, different number (matched by email): keep the new number as an alternate.
  if v_phone is not null and length(v_phone) >= 8 and v_phone <> l.phone
     and public.phone_key(v_phone) is distinct from l.phone_key
     and not exists (select 1 from public.lead_phones where org_id = l.org_id and phone = v_phone) then
    insert into public.lead_phones (org_id, lead_id, phone, label) values (l.org_id, l.id, v_phone, 'Came in again with this number')
    on conflict do nothing;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'repeated', jsonb_strip_nulls(jsonb_build_object('source', nullif(trim(p_source), ''),
    'campaign', nullif(trim(p_campaign), ''), 'batch_id', p_batch, 'via', p_kind)));
  -- A registration (form, sheet, file) for someone who so far only turned up via the Zoom report: now registered.
  if p_batch is not null and coalesce(p_source, '') <> 'Zoom attendee' then
    update public.batch_leads set registered = true where batch_id = p_batch and lead_id = l.id and not registered;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.apply_zoom_report(p_batch uuid, p_rows jsonb, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid; v_prefix text; r jsonb; v_lead uuid; v_phone text; v_email text; v_min int;
  by_email int := 0; by_phone int := 0; added int := 0; unmatched jsonb := '[]'::jsonb; matched uuid[] := '{}';
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_email := nullif(lower(trim(r->>'email')), '');
    v_phone := public.normalize_phone(nullif(r->>'phone', ''), v_prefix);
    v_min := greatest(0, coalesce(round((r->>'minutes')::numeric)::int, 0));
    v_lead := null;
    if v_email is not null then
      select id into v_lead from public.leads where org_id = v_org and email = v_email and deleted_at is null
      order by (exists (select 1 from public.batch_leads b where b.batch_id = p_batch and b.lead_id = leads.id)) desc limit 1;
      if v_lead is not null then by_email := by_email + 1; end if;
    end if;
    if v_lead is null and v_phone is not null and length(v_phone) >= 8 then
      select id into v_lead from public.leads where org_id = v_org and phone = v_phone and deleted_at is null;
      if v_lead is null then select lead_id into v_lead from public.lead_phones where org_id = v_org and phone = v_phone; end if;
      if v_lead is not null then by_phone := by_phone + 1; end if;
    end if;

    if v_lead is null then
      unmatched := unmatched || jsonb_build_array(r - 'sessions');
      continue;
    end if;
    if not exists (select 1 from public.batch_leads where batch_id = p_batch and lead_id = v_lead) then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, registered) values (p_batch, v_lead, v_org, false, false);
      added := added + 1;
    end if;
    update public.batch_leads set
      watch_minutes = case when v_lead = any(matched) then coalesce(watch_minutes, 0) + v_min else v_min end,
      attended = v_min > 0 or attended,
      sessions = case when jsonb_typeof(r->'sessions') <> 'array' then (case when v_lead = any(matched) then sessions end)
                      when v_lead = any(matched) then coalesce(sessions, '[]'::jsonb) || (r->'sessions') else r->'sessions' end,
      zoom_name = coalesce(nullif(trim(r->>'name'), ''), zoom_name)
    where batch_id = p_batch and lead_id = v_lead;
    matched := matched || v_lead;
  end loop;

  update public.batch_leads set watch_minutes = 0, attended = false, sessions = null, at_pitch = null
  where batch_id = p_batch and not (lead_id = any(matched));
  update public.batches set zoom_uploaded_at = now(), started_at = coalesce(p_started_at, started_at) where id = p_batch;
  perform public.batch_recompute(p_batch);
  perform public.write_audit(v_org, 'batch.zoom_uploaded', 'batch', p_batch::text,
    jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added', added, 'unmatched', jsonb_array_length(unmatched)));
  return jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added_to_batch', added, 'unmatched', unmatched);
end $function$;

-- ───── Repair existing webinars ─────
-- Walk-ins: no registration arrival for this webinar, and either created from the Zoom file or added by the Zoom
-- report itself (that runs in one transaction, so its rows carry exactly the upload time).
update public.batch_leads bl set registered = false
from public.batches b, public.leads l
where b.id = bl.batch_id and l.id = bl.lead_id and bl.registered
  and (l.source = 'Zoom attendee' or bl.added_at = b.zoom_uploaded_at)
  and not exists (select 1 from public.lead_origins lo where lo.lead_id = bl.lead_id and lo.batch_id = bl.batch_id
                  and lo.kind in ('import', 'webhook', 'app') and coalesce(lo.source, '') <> 'Zoom attendee');

-- No-shows that arrived after the Zoom report.
update public.batch_leads bl set watch_minutes = 0, attended = false
from public.batches b where b.id = bl.batch_id and b.zoom_uploaded_at is not null and bl.watch_minutes is null;

do $$ declare r record; begin
  for r in select id, zoom_uploaded_at from public.batches loop
    perform public.batch_prev_fill(r.id, null);
    if r.zoom_uploaded_at is not null then perform public.batch_recompute(r.id); end if;
  end loop;
end $$;
