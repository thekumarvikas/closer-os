-- Owner feedback, round 1:
--  • team members have a phone number (profiles.phone) — admins can set it, people can set their own
--  • calls remember which SIM number they were made from (calls.sim_number)
--  • follow-up discipline: when was the follow-up actually dialled, and was it late (> 15 min)?
--  • a lead created later picks up earlier calls with that number
--  • batches have a type: webinar / event / batch, and can be compared with each other

-- ───────────── Team member phone ─────────────
create or replace function public.set_member_phone(p_org uuid, p_user uuid, p_phone text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_prefix text;
begin
  if not (p_user = auth.uid() or public.is_org_admin(p_org)) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.org_members where org_id = p_org and user_id = p_user) then raise exception 'Not in this company'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  update public.profiles set phone = public.normalize_phone(nullif(trim(p_phone), ''), v_prefix) where id = p_user;
end $$;
revoke execute on function public.set_member_phone(uuid, uuid, text) from anon, public;
grant execute on function public.set_member_phone(uuid, uuid, text) to authenticated;

-- ───────────── SIM number on calls ─────────────
alter table public.calls add column if not exists sim_number text;

-- ───────────── Follow-up discipline ─────────────
-- dialled_at = first outgoing call by the assignee to the lead from 10 minutes before the due time.
-- Late = dialled more than 15 minutes after the due time, or not dialled at all by then.
alter table public.follow_ups add column if not exists dialled_at timestamptz;

create or replace function public.mark_follow_up_dialled()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.lead_id is not null and new.direction = 'outgoing' then
    update public.follow_ups set dialled_at = new.started_at
    where lead_id = new.lead_id and assigned_to = new.user_id and dialled_at is null
      and status <> 'cancelled'
      and due_at <= new.started_at + interval '10 minutes'
      and due_at >= new.started_at - interval '2 days';
  end if;
  return new;
end $$;
drop trigger if exists t_call_follow_up on public.calls;
create trigger t_call_follow_up after insert or update of lead_id on public.calls
  for each row execute function public.mark_follow_up_dialled();

-- Per-rep follow-up discipline for a period (by due time).
create or replace function public.follow_up_report(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then
    v_users := array(select unnest(v_users) intersect select unnest(p_users));
  end if;
  with f as (
    select assigned_to, due_at, dialled_at, status,
      case
        when dialled_at is not null and dialled_at <= due_at + interval '15 minutes' then 'on_time'
        when dialled_at is not null then 'late'
        when now() > due_at + interval '15 minutes' then 'missed'
        else 'upcoming' end as state
    from public.follow_ups
    where org_id = p_org and due_at >= p_from and due_at < p_to and status <> 'cancelled'
      and assigned_to = any(v_users)
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into res from (
    select grouping(assigned_to) as g, assigned_to,
      count(*) as due,
      count(*) filter (where state = 'on_time') as on_time,
      count(*) filter (where state = 'late') as late,
      count(*) filter (where state = 'missed') as missed,
      count(*) filter (where state = 'upcoming') as upcoming,
      coalesce(round(avg(extract(epoch from dialled_at - due_at) / 60) filter (where dialled_at is not null)), 0) as avg_delay_min
    from f group by grouping sets ((assigned_to), ())
  ) x;
  return res;
end $$;
revoke execute on function public.follow_up_report(uuid, timestamptz, timestamptz, uuid[]) from anon, public;
grant execute on function public.follow_up_report(uuid, timestamptz, timestamptz, uuid[]) to authenticated;

-- ───────────── New lead picks up its earlier calls ─────────────
create or replace function public.link_calls_to_new_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.calls set lead_id = new.id where org_id = new.org_id and phone = new.phone and lead_id is null;
  update public.leads set last_call_at = (select max(started_at) from public.calls where lead_id = new.id) where id = new.id
    and exists (select 1 from public.calls where lead_id = new.id);
  return new;
end $$;
drop trigger if exists t_lead_link_calls on public.leads;
create trigger t_lead_link_calls after insert on public.leads
  for each row execute function public.link_calls_to_new_lead();

-- ───────────── Batch type + comparison ─────────────
alter table public.batches add column if not exists kind text not null default 'webinar' check (kind in ('webinar', 'event', 'batch'));

create or replace function public.batch_compare(p_org uuid, p_limit int default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b record; s jsonb; r jsonb; out jsonb := '[]'::jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  for b in select id, name, kind, webinar_at, zoom_uploaded_at, hot_minutes from public.batches
           where org_id = p_org and not is_archived order by webinar_at desc limit least(p_limit, 30) loop
    select jsonb_build_object(
      'leads', count(*),
      'reminder_called', count(*) filter (where attempts > 0),
      'guided', count(*) filter (where guided),
      'joined', count(*) filter (where attended),
      'stayed', count(*) filter (where is_hot),
      'repeated', count(*) filter (where is_repeat))
    into r from public.batch_lead_facts(b.id, 'reminder');
    select jsonb_build_object(
      'sales_called', count(*) filter (where attempts > 0),
      'picked', count(*) filter (where max_dur > 30),
      'over5', count(*) filter (where max_dur > 300),
      'won', count(*) filter (where won),
      'revenue', coalesce(sum(revenue), 0))
    into s from public.batch_lead_facts(b.id, 'sales');
    out := out || jsonb_build_array(jsonb_build_object('id', b.id, 'name', b.name, 'kind', b.kind, 'at', b.webinar_at,
      'zoom', b.zoom_uploaded_at is not null) || r || s);
  end loop;
  return out;
end $$;
revoke execute on function public.batch_compare(uuid, int) from anon, public;
grant execute on function public.batch_compare(uuid, int) to authenticated;

drop function if exists public.set_call_sim_number();

-- ───────────── sync_calls / log_call: also store the SIM's phone number ─────────────
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
                              duration_sec, sim_slot, sim_label, sim_number, recording_status)
    values ((r->>'id')::uuid, p_org, v_lead, auth.uid(), r->>'device_id', v_dir, v_phone, (r->>'started_at')::timestamptz,
            (r->>'started_at')::timestamptz + make_interval(secs => v_dur), v_dur,
            nullif(r->>'sim_slot', '')::int, nullif(r->>'sim_label', ''), public.normalize_phone(nullif(r->>'sim_number', ''), v_prefix), 'not_expected')
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
  v_purpose text := coalesce(nullif(p->>'purpose', ''), 'sales');
  v_batch uuid := nullif(p->>'batch_id', '')::uuid;
  v_prefix text; v_cat public.outcome_category; v_code text; v_fu uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member of this company'; end if;
  if v_purpose not in ('sales', 'reminder') then raise exception 'Unknown call purpose'; end if;
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
end $$;
