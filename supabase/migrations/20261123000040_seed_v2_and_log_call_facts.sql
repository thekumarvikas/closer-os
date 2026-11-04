-- New companies get the v2 outcome list; log_call stores facts (lead_custom) and tags (lead_tags) on the lead.
CREATE OR REPLACE FUNCTION public.create_organization(p_name text, p_country_code text DEFAULT 'IN'::text, p_phone_prefix text DEFAULT '+91'::text, p_currency text DEFAULT 'INR'::text, p_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.organizations (name, country_code, phone_prefix, currency, timezone, created_by)
  values (trim(p_name), upper(p_country_code), p_phone_prefix, upper(p_currency), p_timezone, auth.uid())
  returning id into v_org;

  insert into public.org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');

  insert into public.pipeline_stages (org_id, name, position, is_won, is_lost) values
    (v_org, 'New', 1, false, false),
    (v_org, 'Contacted', 2, false, false),
    (v_org, 'Interested', 3, false, false),
    (v_org, 'Qualified', 4, false, false),
    (v_org, 'Payment Link Shared', 5, false, false),
    (v_org, 'Won', 6, true, false),
    (v_org, 'Lost', 7, false, true);

  insert into public.call_outcomes (org_id, code, label, category, form, position) values
    (v_org, 'no_answer',        'No Answer',                 'not_connected', null,        1),
    (v_org, 'busy',             'Busy',                      'not_connected', null,        2),
    (v_org, 'not_reachable',    'Not Reachable',             'not_connected', null,        3),
    (v_org, 'rejected',         'Call Rejected',             'not_connected', null,        4),
    (v_org, 'not_interested',   'Connected – Not Interested','lost',          null,        5),
    (v_org, 'interested',       'Interested',                'positive',      'interest',  6),
    (v_org, 'follow_up',        'Follow-up Required',        'connected',     null,        7),
    (v_org, 'call_back',        'Call Back Later',           'connected',     null,        8),
    (v_org, 'qualified',        'Qualified',                 'positive',      'interest',  9),
    (v_org, 'payment_link',     'Payment Link Shared',       'positive',      null,        10),
    (v_org, 'sale_closed',      'Sale Closed',               'won',           'sale',      11),
    (v_org, 'sale_lost',        'Sale Lost',                 'lost',          null,        12),
    (v_org, 'wrong_number',     'Wrong Number',              'invalid',       null,        13),
    (v_org, 'do_not_call',      'Do Not Call',               'invalid',       null,        14),
    (v_org, 'other',            'Other',                     'connected',     null,        15);

  perform public.apply_outcome_set_v2(v_org);
  perform public.write_audit(v_org, 'organization.created', 'organization', v_org::text, jsonb_build_object('name', p_name));
  return v_org;
end $function$;

CREATE OR REPLACE FUNCTION public.log_call(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_id uuid := (p->>'id')::uuid;
  v_lead uuid := nullif(p->>'lead_id', '')::uuid;
  v_outcome uuid := nullif(p->>'outcome_id', '')::uuid;
  v_follow timestamptz := nullif(p->>'follow_up_at', '')::timestamptz;
  v_no_follow boolean := coalesce((p->>'no_follow_up')::boolean, false);
  v_stage uuid := nullif(p->>'stage_id', '')::uuid;
  v_purpose text := coalesce(nullif(p->>'purpose', ''), 'sales');
  v_batch uuid := nullif(p->>'batch_id', '')::uuid;
  v_prefix text; v_cat public.outcome_category; v_code text; v_fu uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member of this company'; end if;
  if v_purpose not in ('sales', 'reminder') then raise exception 'Unknown call purpose'; end if;
  -- A call with a number that isn't in the lead list (after-call pop-up): add it as a lead now, assigned to the caller.
  if v_lead is null and coalesce((p->>'create_lead')::boolean, false) and coalesce(p->>'phone', '') <> '' then
    select l.id into v_lead from public.leads l
     where l.org_id = v_org and l.deleted_at is null
       and l.phone = public.normalize_phone(p->>'phone', (select o.phone_prefix from public.organizations o where o.id = v_org));
    if v_lead is null then
      insert into public.leads (org_id, name, phone, source, assigned_to)
      values (v_org, coalesce(nullif(trim(p->>'lead_name'), ''), ''), p->>'phone', 'Phone call', auth.uid())
      returning id into v_lead;
    end if;
  end if;
  if v_lead is not null and not public.lead_visible(v_lead) then raise exception 'Lead not found'; end if;
  if v_batch is not null and not exists (select 1 from public.batches where id = v_batch and org_id = v_org) then
    raise exception 'Unknown webinar batch';
  end if;
  if v_outcome is not null then
    select category, code into v_cat, v_code from public.call_outcomes where id = v_outcome and org_id = v_org;
    if v_cat is null then raise exception 'Unknown outcome'; end if;
    if v_follow is null and not v_no_follow then
      raise exception 'Choose the next call time or "No follow-up needed"';
    end if;
  end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;

  insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                            duration_sec, sim_slot, sim_label, outcome_id, outcome_data, notes, from_dialer_queue,
                            recording_status, purpose, batch_id, sim_number)
  values (
    v_id, v_org, v_lead, auth.uid(), p->>'device_id', (p->>'direction')::public.call_direction,
    public.normalize_phone(p->>'phone', v_prefix), (p->>'started_at')::timestamptz, nullif(p->>'ended_at', '')::timestamptz,
    coalesce((p->>'duration_sec')::int, 0), nullif(p->>'sim_slot', '')::int, p->>'sim_label', v_outcome,
    coalesce(p->'outcome_data', '{}'::jsonb), p->>'notes', coalesce((p->>'from_dialer_queue')::boolean, false),
    coalesce(nullif(p->>'recording_status', ''), 'not_expected')::public.recording_status, v_purpose, v_batch,
    public.normalize_phone(nullif(p->>'sim_number', ''), v_prefix)
  )
  on conflict (id) do update set
    outcome_id = coalesce(excluded.outcome_id, public.calls.outcome_id),
    outcome_data = case when excluded.outcome_id is not null then excluded.outcome_data else public.calls.outcome_data end,
    notes = coalesce(excluded.notes, public.calls.notes),
    lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
    ended_at = coalesce(excluded.ended_at, public.calls.ended_at),
    duration_sec = greatest(excluded.duration_sec, public.calls.duration_sec),
    recording_status = excluded.recording_status,
    purpose = excluded.purpose,
    batch_id = coalesce(excluded.batch_id, public.calls.batch_id),
    sim_number = coalesce(excluded.sim_number, public.calls.sim_number)
  where public.calls.user_id = auth.uid();

  if v_lead is not null then
    update public.leads set
      last_call_at = greatest(coalesce(last_call_at, '-infinity'), (p->>'started_at')::timestamptz),
      last_outcome_id = coalesce(v_outcome, last_outcome_id),
      stage_id = coalesce(v_stage, stage_id),
      profession = coalesce(nullif(p->>'profession', ''), profession),
      profession_category_id = coalesce(nullif(p->>'profession_category_id', '')::uuid, profession_category_id),
      do_not_call = do_not_call or v_code = 'do_not_call',
      deal_value = coalesce(nullif(p->'outcome_data'->>'deal_value', '')::numeric, nullif(p->'outcome_data'->>'amount', '')::numeric, deal_value),
      notes = case when nullif(p->>'notes', '') is null then notes
                   else concat_ws(E'\n', notes, to_char(now() at time zone 'Asia/Kolkata', 'DD/MM HH24:MI') || ': ' || (p->>'notes')) end
    where id = v_lead;

    -- Facts captured on the outcome form (company's "facts to capture") and quick tags go onto the lead.
    if jsonb_typeof(p->'lead_custom') = 'object' then
      update public.leads set custom = coalesce(custom, '{}'::jsonb) || (p->'lead_custom') where id = v_lead;
    end if;
    if jsonb_typeof(p->'lead_tags') = 'array' then
      update public.leads set tags = array(select distinct t from unnest(coalesce(tags, '{}') || array(select jsonb_array_elements_text(p->'lead_tags'))) t)
      where id = v_lead;
    end if;

    if v_outcome is not null then
      -- Each outcome sets the lead's one next-call time for this kind of call (sales or reminder).
      update public.follow_ups
      set status = case when due_at <= now() then 'done'::public.follow_up_status else 'cancelled'::public.follow_up_status end,
          completed_at = now()
      where lead_id = v_lead and status = 'pending' and purpose = v_purpose;

      if v_follow is not null then
        insert into public.follow_ups (org_id, lead_id, assigned_to, due_at, reason, notes, call_id, created_by, priority, purpose)
        values (v_org, v_lead,
                case when v_purpose = 'reminder' then auth.uid() else coalesce((select assigned_to from public.leads where id = v_lead), auth.uid()) end,
                v_follow, p->>'follow_up_reason', p->>'follow_up_notes', v_id, auth.uid(),
                coalesce((p->>'follow_up_priority')::smallint, 2), v_purpose)
        returning id into v_fu;
      end if;
      update public.leads set next_follow_up_at = (
        select min(due_at) from public.follow_ups where lead_id = v_lead and status = 'pending'
      ) where id = v_lead;

      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (v_org, v_lead, auth.uid(), 'call', jsonb_build_object(
        'call_id', v_id, 'direction', p->>'direction', 'duration_sec', p->>'duration_sec', 'purpose', v_purpose,
        'outcome', v_code, 'follow_up_at', v_follow, 'no_follow_up', v_no_follow));
    end if;
  end if;
  return jsonb_build_object('call_id', v_id, 'follow_up_id', v_fu);
end $function$;
