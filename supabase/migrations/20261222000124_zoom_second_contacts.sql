-- Zoom file matched a lead by email but shows another number (or by number with another email): keep it as a
-- second number / email on the SAME lead (one person = one lead; exact match only).
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
      if v_lead is null then select lead_id into v_lead from public.lead_phones where org_id = v_org and phone = v_phone; end if;
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
