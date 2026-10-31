-- Call-log sync from the Android app.
-- The phone sends its call log; each call gets a stable id (made on the phone from the call-log
-- entry), so sending the same call twice never creates a duplicate.
-- Company setting organizations.settings->>'call_tracking':
--   'all'   (default) every call on the work phone is uploaded, like Callyzer
--   'leads' only calls to numbers that are leads are uploaded

create or replace function public.sync_calls(p_org uuid, p_calls jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text; v_prefix text; r jsonb; v_phone text; v_lead uuid; v_dir public.call_direction; v_dur int;
  n int := 0; skipped int := 0; out jsonb := '[]'::jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member of this company'; end if;
  if jsonb_array_length(p_calls) > 500 then raise exception 'Send at most 500 calls at a time'; end if;
  select coalesce(settings->>'call_tracking', 'all'), phone_prefix into v_mode, v_prefix from public.organizations where id = p_org;

  for r in select * from jsonb_array_elements(p_calls) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then skipped := skipped + 1; continue; end if;   -- private / unknown caller
    v_dir := (r->>'direction')::public.call_direction;
    v_dur := case when v_dir in ('missed', 'rejected') then 0 else greatest(0, coalesce((r->>'duration_sec')::int, 0)) end;

    select id into v_lead from public.leads where org_id = p_org and phone = v_phone and deleted_at is null;
    if v_lead is null then
      select lp.lead_id into v_lead from public.lead_phones lp
      join public.leads l on l.id = lp.lead_id and l.deleted_at is null
      where lp.org_id = p_org and lp.phone = v_phone;
    end if;
    if v_lead is null and v_mode = 'leads' then skipped := skipped + 1; continue; end if;

    insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                              duration_sec, sim_slot, sim_label, recording_status)
    values ((r->>'id')::uuid, p_org, v_lead, auth.uid(), r->>'device_id', v_dir, v_phone, (r->>'started_at')::timestamptz,
            (r->>'started_at')::timestamptz + make_interval(secs => v_dur), v_dur,
            nullif(r->>'sim_slot', '')::int, nullif(r->>'sim_label', ''), 'not_expected')
    on conflict (id) do update set
      duration_sec = greatest(public.calls.duration_sec, excluded.duration_sec),
      lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
      sim_slot = coalesce(public.calls.sim_slot, excluded.sim_slot),
      sim_label = coalesce(public.calls.sim_label, excluded.sim_label)
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

revoke execute on function public.sync_calls(uuid, jsonb) from anon, public;
grant execute on function public.sync_calls(uuid, jsonb) to authenticated;
