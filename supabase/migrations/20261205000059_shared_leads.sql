-- Shared leads: a rep (or a manager) shares a lead with a teammate for follow-up. Both can call it,
-- save outcomes and notes (visible to both), hear recordings, and each keeps their own next-call time.

create table if not exists public.lead_shares (
  lead_id uuid not null references public.leads(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  shared_by uuid, created_at timestamptz not null default now(),
  primary key (lead_id, user_id)
);
alter table public.lead_shares enable row level security;

alter table public.leads add column if not exists shared_with uuid[] not null default '{}';
create index if not exists leads_shared_with on public.leads using gin (shared_with) where cardinality(shared_with) > 0;

create or replace function public.t_lead_shares_sync() returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.leads set shared_with = coalesce((select array_agg(user_id order by created_at) from public.lead_shares where lead_id = v), '{}')
  where id = v;
  return null;
end $$;
drop trigger if exists t_lead_shares_sync on public.lead_shares;
create trigger t_lead_shares_sync after insert or delete on public.lead_shares for each row execute function public.t_lead_shares_sync();

-- Visibility: shared people (and their managers) see the lead — and so its calls, notes, recordings, webinars.
create or replace function public.lead_visible(p_lead uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.leads l
    where l.id = p_lead and (
      public.can_see_lead(l.org_id, l.assigned_to)
      or auth.uid() = any(l.shared_with)
      or exists (select 1 from unnest(l.shared_with) s(u) where public.can_see_user(l.org_id, s.u))
      or exists (select 1 from public.batch_leads bl
                 where bl.lead_id = l.id and bl.reminder_by is not null and public.can_see_user(l.org_id, bl.reminder_by))
    )
  )
$$;
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select using (
  public.is_org_member(org_id) and (
    public.can_see_lead(org_id, assigned_to)
    or auth.uid() = any(shared_with)
    or exists (select 1 from unnest(shared_with) s(u) where public.can_see_user(leads.org_id, s.u))
    or exists (select 1 from public.batch_leads bl
               where bl.lead_id = leads.id and bl.reminder_by is not null and public.can_see_user(leads.org_id, bl.reminder_by))
  )
);
drop policy if exists lead_shares_read on public.lead_shares;
create policy lead_shares_read on public.lead_shares for select to authenticated using (public.lead_visible(lead_id));

-- Share / stop sharing: the owner (assigned rep), anyone it is shared with, or a manager.
create or replace function public.share_lead(p_lead uuid, p_user uuid, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l record;
begin
  select * into l from public.leads where id = p_lead and deleted_at is null;
  if l.id is null or not public.lead_visible(p_lead) then raise exception 'Not allowed'; end if;
  if not (l.assigned_to = auth.uid() or auth.uid() = any(l.shared_with) or public.is_org_manager(l.org_id)) then
    raise exception 'Only the lead''s owner, people it is shared with, or a manager can share it'; end if;
  if p_on then
    if p_user = l.assigned_to then raise exception 'This person already owns the lead'; end if;
    if not exists (select 1 from public.org_members m where m.org_id = l.org_id and m.user_id = p_user and m.status = 'active') then
      raise exception 'Share only with active team members'; end if;
    insert into public.lead_shares (lead_id, org_id, user_id, shared_by) values (p_lead, l.org_id, p_user, auth.uid())
    on conflict do nothing;
  else
    delete from public.lead_shares where lead_id = p_lead and user_id = p_user;
    if l.assigned_to is not null then   -- their pending next calls go back to the owner
      update public.follow_ups set assigned_to = l.assigned_to where lead_id = p_lead and assigned_to = p_user and status = 'pending';
    end if;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, p_lead, auth.uid(), case when p_on then 'shared' else 'unshared' end, jsonb_build_object('with', p_user));
  return jsonb_build_object('shared_with', (select shared_with from public.leads where id = p_lead));
end $$;
revoke execute on function public.share_lead(uuid, uuid, boolean) from anon, public;
grant execute on function public.share_lead(uuid, uuid, boolean) to authenticated;

-- Names of active teammates (to choose who to share with).
create or replace function public.org_people(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.is_org_member(p_org) then coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id,
      'name', coalesce(nullif(p.full_name, ''), p.email), 'role', m.role) order by coalesce(nullif(p.full_name, ''), p.email)), '[]') end
  from public.org_members m join public.profiles p on p.id = m.user_id
  where m.org_id = p_org and m.status = 'active';
$$;
revoke execute on function public.org_people(uuid) from anon, public;
grant execute on function public.org_people(uuid) to authenticated;

create or replace function public.search_leads(p_org uuid, p_q text, p_limit int default 300)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(trim(coalesce(p_q, ''))); digits text; v_rep boolean; res uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if length(q) < 2 then return '{}'; end if;
  digits := regexp_replace(q, '\D', '', 'g');
  v_rep := public.org_role(p_org) = 'rep';
  select array_agg(id) into res from (
    select id from (
      select l.id, l.updated_at from public.leads l
      where l.org_id = p_org and l.deleted_at is null and public.lead_search_text(l) like '%' || q || '%'
      union
      select l.id, l.updated_at from public.leads l
      where length(digits) >= 4 and l.org_id = p_org and l.deleted_at is null and l.phone like '%' || digits || '%'
      union
      select l.id, l.updated_at from public.lead_activities a join public.leads l on l.id = a.lead_id
      where a.kind = 'note' and a.org_id = p_org and lower(a.data->>'text') like '%' || q || '%' and l.deleted_at is null
      union
      select l.id, l.updated_at from public.calls c join public.leads l on l.id = c.lead_id
      where c.org_id = p_org and c.notes is not null and lower(c.notes) like '%' || q || '%' and l.deleted_at is null
    ) m
    where not v_rep or exists (select 1 from public.leads x where x.id = m.id and (x.assigned_to = auth.uid() or auth.uid() = any(x.shared_with)
          or exists (select 1 from public.batch_leads b where b.lead_id = x.id and b.reminder_by = auth.uid())))
    order by updated_at desc limit p_limit) t;
  return coalesce(res, '{}');
end $$;

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
      where lead_id = v_lead and status = 'pending' and purpose = v_purpose
        -- Shared lead: each person keeps their own next call; only the caller's closes.
        and (not exists (select 1 from public.leads x where x.id = v_lead and cardinality(x.shared_with) > 0)
             or assigned_to = auth.uid());

      if v_follow is not null then
        insert into public.follow_ups (org_id, lead_id, assigned_to, due_at, reason, notes, call_id, created_by, priority, purpose)
        values (v_org, v_lead,
                case when v_purpose = 'reminder' or exists (select 1 from public.leads x where x.id = v_lead and auth.uid() = any(x.shared_with)) then auth.uid()
                     else coalesce((select assigned_to from public.leads where id = v_lead), auth.uid()) end,
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

CREATE OR REPLACE FUNCTION public.my_focus_list(p_org uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_day_start timestamptz; v_day_end timestamptz;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_day_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';
  return (with mine as (
      select l.*, o.category cat,
        -- tonight's webinar (starts within 18 h; reminder calls) and the best recent watch time (last 14 days)
        (select b.webinar_at from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'
          order by b.webinar_at limit 1) up_at,
        (select b.name from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'
          order by b.webinar_at limit 1) up_name,
        -- warmest recent webinar (last 14 days): warmth 40+ (watch + pitch + chat + polls) or watched the hot minutes
        (select max(greatest(bl.warmth, case when coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60) then 40 else 0 end))
           from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and b.webinar_at > now() - interval '14 days' and b.webinar_at <= now()
            and (bl.warmth >= 40 or coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60))) hot_min,
        (select coalesce(bl.warm_reason, '🔥 Watched ' || bl.watch_minutes || ' min') from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and b.webinar_at > now() - interval '14 days' and b.webinar_at <= now()
            and (bl.warmth >= 40 or coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60))
          order by bl.warmth desc, bl.watch_minutes desc nulls last limit 1) hot_reason
      from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
      where l.org_id = p_org and l.deleted_at is null and not l.do_not_call
        and (l.assigned_to = auth.uid() or auth.uid() = any(l.shared_with) or exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
              where bl.lead_id = l.id and bl.reminder_by = auth.uid() and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'))
        and coalesce(o.category::text, '') not in ('won', 'lost', 'invalid')
    ), todo as (
      select m.*, public.lead_call_context(m.id)->>'purpose' call_purpose, public.lead_call_context(m.id)->>'batch_id' call_batch_id, case
          when m.next_follow_up_at < now() then 1
          when m.up_at is not null then 2
          when m.next_follow_up_at < now() + interval '2 hours' then 3
          when m.hot_min is not null then 4
          when m.dial_count = 0 then 5
          when m.best_hour = extract(hour from now() at time zone v_tz)::int then 6
          when m.score >= 40 then 7 else 8 end bucket,
        case when m.next_follow_up_at < now() then 'Overdue follow-up'
             when m.up_at is not null then '🎓 Reminder · ' || m.up_name || ' at ' || to_char(m.up_at at time zone v_tz, 'FMHH12:MI AM')
             when m.next_follow_up_at < now() + interval '2 hours' then 'Follow-up due'
             when m.hot_min is not null then '🎥 ' || m.hot_reason
             when m.dial_count = 0 then 'New — not called yet'
             when m.best_hour = extract(hour from now() at time zone v_tz)::int then '⏰ Best time to call now' when m.score >= 40 then '⚡ Close to converting' else null end reason
      from mine m
      where (m.next_follow_up_at is null or m.next_follow_up_at < v_day_end)      -- planned for a later day: not today
        and (m.last_call_at is null or m.last_call_at < v_day_start or m.next_follow_up_at < now() + interval '2 hours')
    )
    select jsonb_build_object(
      'total', (select count(*) from todo),
      'done_today', (select count(*) from mine where last_call_at >= v_day_start),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) - 'up_at' - 'up_name' - 'hot_min' - 'hot_reason' order by t.bucket, t.up_at nulls last, t.next_follow_up_at nulls last,
                  t.hot_min desc nulls last, case when t.bucket = 5 then -extract(epoch from t.created_at) end, t.score desc, t.last_call_at nulls first), '[]')
               from (select * from todo order by bucket, up_at nulls last, next_follow_up_at nulls last, hot_min desc nulls last,
                     case when bucket = 5 then -extract(epoch from created_at) end, score desc, last_call_at nulls first
                     limit p_limit offset p_offset) t)
    ));
end $function$;

create or replace function public.after_lead_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (new.org_id, new.id, auth.uid(), 'assigned', jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
    if new.assigned_to is not null then
      update public.follow_ups set assigned_to = new.assigned_to
      where lead_id = new.id and status = 'pending' and (old.assigned_to is null or assigned_to = old.assigned_to);
      if old.assigned_to is not null then
        update public.batch_leads bl set reminder_by = new.assigned_to
        from public.batches b
        where bl.lead_id = new.id and bl.batch_id = b.id and bl.reminder_by = old.assigned_to and b.webinar_at > now();
      end if;
    end if;
  end if;
  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (new.org_id, new.id, auth.uid(), 'stage_changed', jsonb_build_object('from', old.stage_id, 'to', new.stage_id));
  end if;
  return new;
end $$;
