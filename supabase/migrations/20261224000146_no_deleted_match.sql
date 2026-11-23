-- Never match a DELETED lead through a second number (lead_phones): Zoom upload put 2 attendees on deleted leads (Cancer 23 Nov).
CREATE OR REPLACE FUNCTION public.find_lead(p_org uuid, p_phone text, p_email text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v uuid; k text := public.phone_key(p_phone); e text := public.email_key(p_email);
begin
  if p_phone is not null then
    select id into v from public.leads where org_id = p_org and phone = p_phone and deleted_at is null limit 1;
    if v is not null then return v; end if;
    select lp.lead_id into v from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null where lp.org_id = p_org and lp.phone = p_phone limit 1;
    if v is not null then return v; end if;
  end if;
  if k is not null and length(k) >= 8 then
    select id into v from public.leads where org_id = p_org and phone_key = k and deleted_at is null order by created_at limit 1;
    if v is not null then return v; end if;
    select lp.lead_id into v from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null
      where lp.org_id = p_org and public.phone_key(lp.phone) = k limit 1;
    if v is not null then return v; end if;
  end if;
  if e is not null and position('@' in e) > 1 then
    select id into v from public.leads where org_id = p_org and email_key = e and deleted_at is null order by created_at limit 1;
    if v is not null then return v; end if;
    select le.lead_id into v from public.lead_emails le join public.leads l on l.id = le.lead_id and l.deleted_at is null
      where le.org_id = p_org and le.email_key = e limit 1;
  end if;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.apply_zoom_report(p_batch uuid, p_rows jsonb, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid; v_prefix text; r jsonb; v_lead uuid; v_phone text; v_email text; v_min int;
  v_zoom_reg boolean; v_reg boolean;
  by_email int := 0; by_phone int := 0; added int := 0; unmatched jsonb := '[]'::jsonb; matched uuid[] := '{}';
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;
  -- No registrations from anywhere else (sheet, import, form): Zoom's own registration list is the registration list.
  v_zoom_reg := not exists (select 1 from public.batch_leads where batch_id = p_batch and registered);

  for r in select * from jsonb_array_elements(p_rows) loop
    v_email := nullif(lower(trim(r->>'email')), '');
    v_phone := public.normalize_phone(nullif(r->>'phone', ''), v_prefix);
    v_min := greatest(0, coalesce(round((r->>'minutes')::numeric)::int, 0));
    v_lead := null;
    v_reg := false;  -- Zoom never marks someone as registered (owner, Nov 21)
    if v_email is not null then
      select id into v_lead from public.leads where org_id = v_org and email = v_email and deleted_at is null
      order by (exists (select 1 from public.batch_leads b where b.batch_id = p_batch and b.lead_id = leads.id)) desc limit 1;
      if v_lead is not null then by_email := by_email + 1; end if;
    end if;
    if v_lead is null and v_phone is not null and length(v_phone) >= 8 then
      select id into v_lead from public.leads where org_id = v_org and phone = v_phone and deleted_at is null;
      if v_lead is null then select lp.lead_id into v_lead from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null where lp.org_id = v_org and lp.phone = v_phone limit 1; end if;
      if v_lead is not null then by_phone := by_phone + 1; end if;
    end if;

    -- Same rules as the lead import: last 10 digits, other numbers of the lead, email with a fixed spelling.
    if v_lead is null and (v_email is not null or coalesce(length(v_phone), 0) >= 8) then
      v_lead := public.find_lead(v_org, v_phone, v_email);
      if v_lead is not null then by_phone := by_phone + 1; end if;
    end if;
    if v_lead is null then
      unmatched := unmatched || jsonb_build_array(r - 'sessions');
      continue;
    end if;
    if not exists (select 1 from public.batch_leads where batch_id = p_batch and lead_id = v_lead) then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, registered) values (p_batch, v_lead, v_org, false, v_reg);
      added := added + 1;
    end if;
    update public.batch_leads set
      watch_minutes = case when v_lead = any(matched) then coalesce(watch_minutes, 0) + v_min else v_min end,
      attended = v_min > 0 or attended,
      registered = registered or v_reg,
      sessions = case when jsonb_typeof(r->'sessions') <> 'array' then (case when v_lead = any(matched) then sessions end)
                      when v_lead = any(matched) then coalesce(sessions, '[]'::jsonb) || (r->'sessions') else r->'sessions' end,
      zoom_name = coalesce(nullif(trim(r->>'name'), ''), zoom_name)
    where batch_id = p_batch and lead_id = v_lead;
    -- Same person, other contact details in the Zoom file → keep them on the lead as a second number / email.
    if v_phone is not null and length(public.phone_key(v_phone)) >= 8
       and not exists (select 1 from public.leads where id = v_lead and phone_key = public.phone_key(v_phone))
       and not exists (select 1 from public.lead_phones where lead_id = v_lead and public.phone_key(phone) = public.phone_key(v_phone)) then
      insert into public.lead_phones (org_id, lead_id, phone, label, source) values (v_org, v_lead, v_phone, 'Secondary', 'zoom') on conflict do nothing;
    end if;
    if v_email is not null and position('@' in v_email) > 1
       and not exists (select 1 from public.leads where id = v_lead and email_key = public.email_key(v_email))
       and not exists (select 1 from public.lead_emails where lead_id = v_lead and email_key = public.email_key(v_email)) then
      insert into public.lead_emails (org_id, lead_id, email, email_key, label, source) values (v_org, v_lead, v_email, public.email_key(v_email), 'Secondary', 'zoom') on conflict do nothing;
    end if;
    matched := matched || v_lead;
  end loop;

  update public.batch_leads set watch_minutes = 0, attended = false, sessions = null, at_pitch = null
  where batch_id = p_batch and not (lead_id = any(matched));
  update public.batches set zoom_uploaded_at = now(), started_at = coalesce(p_started_at, started_at) where id = p_batch;
  perform public.batch_recompute(p_batch);
  perform public.write_audit(v_org, 'batch.zoom_uploaded', 'batch', p_batch::text,
    jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added', added, 'unmatched', jsonb_array_length(unmatched)));
  return jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added_to_batch', added, 'unmatched', unmatched);
end $function$
;

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
  std text[] := array['name','phone','email','country','state','city','timezone','profession','company','source','campaign','notes','deal_value','tags','watch_minutes','signup_at'];
  v_tz text; v_signup timestamptz;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only admins and managers can import leads'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_assign_mode = 'user' and (p_assign_to is null or not public.can_see_user(p_org, p_assign_to)) then
    raise exception 'Choose someone you manage to assign these leads to';
  end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then
    raise exception 'Unknown webinar batch';
  end if;
  select phone_prefix, coalesce(timezone, 'Asia/Kolkata') into v_prefix, v_tz from public.organizations where id = p_org;
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
      select lp.lead_id into v_existing from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null where lp.org_id = p_org and lp.phone = v_phone limit 1;
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
      if p_batch is null then
                v_dup := v_dup + 1; continue;
      end if;
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
                              source, campaign, notes, deal_value, tags, custom, assigned_to, signup_at)
    values (
      p_org, coalesce(r->>'name', ''), v_phone, v_email, r->>'country', r->>'state', r->>'city', r->>'timezone',
      r->>'profession', r->>'company', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign),
      r->>'notes', nullif(regexp_replace(coalesce(r->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric,
      coalesce(array(select trim(x) from unnest(string_to_array(r->>'tags', ',')) x where trim(x) <> ''), '{}'),
      coalesce(r->'custom', '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(r) as e(k, v) where k <> 'custom' and not k = any(std)), '{}'::jsonb),
      v_assignee, coalesce(public.signup_guess(r->>'signup_at', v_tz, now(), (select webinar_at from public.batches where id = p_batch)), now())
    ) returning id into v_new;
    if p_batch is null then perform public.lead_join_webinar(v_new, coalesce(r->>'webinar_date', r->'custom'->>'webinar_date'), null); end if;
    if p_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended, registered)
      values (p_batch, v_new, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0, v_reg);
    end if;
    v_ins := v_ins + 1;
  end loop;

  perform set_config('closeros.skip_distribution', 'off', true);
  perform public.write_audit(p_org, 'leads.imported', 'lead', null,
    jsonb_build_object('inserted', v_ins, 'joined_batch', v_joined, 'duplicates', v_dup, 'invalid', v_bad, 'source', p_source, 'batch', p_batch));
  perform public.sales_fill_gaps(p_org);
  return jsonb_build_object('inserted', v_ins, 'joined', v_joined, 'duplicates', v_dup, 'invalid', v_bad);
end $function$
;
