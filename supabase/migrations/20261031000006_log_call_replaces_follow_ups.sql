-- A call outcome replaces the lead's previous open follow-ups (see comment inside).
create or replace function public.log_call(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_id uuid := (p->>'id')::uuid;
  v_lead uuid := nullif(p->>'lead_id', '')::uuid;
  v_outcome uuid := nullif(p->>'outcome_id', '')::uuid;
  v_follow timestamptz := nullif(p->>'follow_up_at', '')::timestamptz;
  v_no_follow boolean := coalesce((p->>'no_follow_up')::boolean, false);
  v_stage uuid := nullif(p->>'stage_id', '')::uuid;
  v_prefix text; v_cat public.outcome_category; v_code text; v_fu uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member of this company'; end if;
  if v_lead is not null and not public.lead_visible(v_lead) then raise exception 'Lead not found'; end if;
  if v_outcome is not null then
    select category, code into v_cat, v_code from public.call_outcomes where id = v_outcome and org_id = v_org;
    if v_cat is null then raise exception 'Unknown outcome'; end if;
    if v_follow is null and not v_no_follow then
      raise exception 'Choose the next call time or "No follow-up needed"';
    end if;
  end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;

  insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                            duration_sec, sim_slot, sim_label, outcome_id, outcome_data, notes, from_dialer_queue, recording_status)
  values (
    v_id, v_org, v_lead, auth.uid(), p->>'device_id', (p->>'direction')::public.call_direction,
    public.normalize_phone(p->>'phone', v_prefix), (p->>'started_at')::timestamptz, nullif(p->>'ended_at', '')::timestamptz,
    coalesce((p->>'duration_sec')::int, 0), nullif(p->>'sim_slot', '')::int, p->>'sim_label', v_outcome,
    coalesce(p->'outcome_data', '{}'::jsonb), p->>'notes', coalesce((p->>'from_dialer_queue')::boolean, false),
    coalesce(nullif(p->>'recording_status', ''), 'not_expected')::public.recording_status
  )
  on conflict (id) do update set
    outcome_id = coalesce(excluded.outcome_id, public.calls.outcome_id),
    outcome_data = case when excluded.outcome_id is not null then excluded.outcome_data else public.calls.outcome_data end,
    notes = coalesce(excluded.notes, public.calls.notes),
    lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
    ended_at = coalesce(excluded.ended_at, public.calls.ended_at),
    duration_sec = greatest(excluded.duration_sec, public.calls.duration_sec),
    recording_status = excluded.recording_status
  where public.calls.user_id = auth.uid();

  if v_lead is not null then
    update public.leads set
      last_call_at = greatest(coalesce(last_call_at, '-infinity'), (p->>'started_at')::timestamptz),
      last_outcome_id = coalesce(v_outcome, last_outcome_id),
      stage_id = coalesce(v_stage, stage_id),
      do_not_call = do_not_call or v_code = 'do_not_call',
      deal_value = coalesce(nullif(p->'outcome_data'->>'deal_value', '')::numeric, nullif(p->'outcome_data'->>'amount', '')::numeric, deal_value),
      notes = case when nullif(p->>'notes', '') is null then notes
                   else concat_ws(E'\n', notes, to_char(now() at time zone 'Asia/Kolkata', 'DD/MM HH24:MI') || ': ' || (p->>'notes')) end
    where id = v_lead;

    if v_outcome is not null then
      -- Every outcome sets the lead's one next-call time, so older open follow-ups are closed:
      -- ones already due count as done, future ones are replaced (cancelled).
      update public.follow_ups
      set status = case when due_at <= now() then 'done'::public.follow_up_status else 'cancelled'::public.follow_up_status end,
          completed_at = now()
      where lead_id = v_lead and status = 'pending';

      if v_follow is not null then
        insert into public.follow_ups (org_id, lead_id, assigned_to, due_at, reason, notes, call_id, created_by, priority)
        values (v_org, v_lead, coalesce((select assigned_to from public.leads where id = v_lead), auth.uid()), v_follow,
                p->>'follow_up_reason', p->>'follow_up_notes', v_id, auth.uid(), coalesce((p->>'follow_up_priority')::smallint, 2))
        returning id into v_fu;
      end if;
      update public.leads set next_follow_up_at = (
        select min(due_at) from public.follow_ups where lead_id = v_lead and status = 'pending'
      ) where id = v_lead;

      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (v_org, v_lead, auth.uid(), 'call', jsonb_build_object(
        'call_id', v_id, 'direction', p->>'direction', 'duration_sec', p->>'duration_sec',
        'outcome', v_code, 'follow_up_at', v_follow, 'no_follow_up', v_no_follow));
    end if;
  end if;
  return jsonb_build_object('call_id', v_id, 'follow_up_id', v_fu);
end $$;
