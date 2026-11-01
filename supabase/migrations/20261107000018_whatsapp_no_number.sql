-- WhatsApp calls are uploaded even when only the contact's saved name is known (phone = ''),
-- so the rep's WhatsApp talk time is always counted.
create or replace function public.sync_calls(p_org uuid, p_calls jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text; v_wa boolean; v_prefix text; r jsonb; v_phone text; v_lead uuid; v_dir public.call_direction; v_dur int;
  v_channel text; n int := 0; skipped int := 0; out jsonb := '[]'::jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member of this company'; end if;
  if jsonb_array_length(p_calls) > 500 then raise exception 'Send at most 500 calls at a time'; end if;
  select coalesce(settings->>'call_tracking', 'all'), coalesce((settings->>'track_whatsapp')::boolean, true), phone_prefix into v_mode, v_wa, v_prefix from public.organizations where id = p_org;

  for r in select * from jsonb_array_elements(p_calls) loop
    v_channel := coalesce(nullif(r->>'channel', ''), 'phone');
    if v_channel not in ('phone', 'whatsapp') then skipped := skipped + 1; continue; end if;
    if v_channel = 'whatsapp' and not v_wa then skipped := skipped + 1; continue; end if;
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_channel = 'whatsapp' and (v_phone is null or length(v_phone) < 8) then
      -- WhatsApp call to a saved name whose number the phone couldn't tell us: still counts for talk time.
      if nullif(r->>'contact_name', '') is null then skipped := skipped + 1; continue; end if;
      v_phone := '';
    elsif v_phone is null or length(v_phone) < 8 then skipped := skipped + 1; continue;   -- private / unknown caller
    end if;
    v_dir := (r->>'direction')::public.call_direction;
    v_dur := case when v_dir in ('missed', 'rejected') then 0 else greatest(0, coalesce((r->>'duration_sec')::int, 0)) end;

    v_lead := null;
    if v_phone <> '' then
    select id into v_lead from public.leads where org_id = p_org and phone = v_phone and deleted_at is null;
    end if;
    if v_lead is null then
      select lp.lead_id into v_lead from public.lead_phones lp
      join public.leads l on l.id = lp.lead_id and l.deleted_at is null
      where lp.org_id = p_org and lp.phone = v_phone;
    end if;
    if v_lead is null and v_mode = 'leads' then skipped := skipped + 1; continue; end if;

    insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                              duration_sec, sim_slot, sim_label, sim_number, recording_status, channel, contact_name)
    values ((r->>'id')::uuid, p_org, v_lead, auth.uid(), r->>'device_id', v_dir, v_phone, (r->>'started_at')::timestamptz,
            (r->>'started_at')::timestamptz + make_interval(secs => v_dur), v_dur,
            nullif(r->>'sim_slot', '')::int, nullif(r->>'sim_label', ''), public.normalize_phone(nullif(r->>'sim_number', ''), v_prefix), 'not_expected',
            v_channel, nullif(r->>'contact_name', ''))
    on conflict (id) do update set
      duration_sec = greatest(public.calls.duration_sec, excluded.duration_sec),
      lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
      sim_slot = coalesce(public.calls.sim_slot, excluded.sim_slot),
      sim_label = coalesce(public.calls.sim_label, excluded.sim_label),
      sim_number = coalesce(public.calls.sim_number, excluded.sim_number)
    where public.calls.user_id = auth.uid();

    if v_lead is not null then
      update public.leads set last_call_at = greatest(coalesce(last_call_at, '-infinity'), (r->>'started_at')::timestamptz)
      where id = v_lead;
    end if;
    n := n + 1;
    out := out || jsonb_build_array(jsonb_build_object('id', r->>'id', 'lead_id', v_lead));
  end loop;
  return jsonb_build_object('synced', n, 'skipped', skipped, 'calls', out);
end $$;


