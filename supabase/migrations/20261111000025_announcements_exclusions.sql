-- Announcements that must be acknowledged; numbers excluded from call tracking; new-lead alerts.

-- ───────────── Announcements ─────────────
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  body text not null,
  urgent boolean not null default false,
  audience text not null default 'all' check (audience in ('all', 'teams', 'people')),
  team_ids uuid[] not null default '{}',
  user_ids uuid[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  reminded_at timestamptz,
  closed_at timestamptz
);
create index if not exists announcements_org_idx on public.announcements (org_id, created_at desc);
create table if not exists public.announcement_acks (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seen_at timestamptz,
  acked_at timestamptz,
  primary key (announcement_id, user_id)
);
alter table public.announcements enable row level security;
alter table public.announcement_acks enable row level security;
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select using (public.is_org_manager(org_id));
drop policy if exists announcement_acks_read on public.announcement_acks;
create policy announcement_acks_read on public.announcement_acks for select using (
  user_id = auth.uid() or exists (select 1 from public.announcements a where a.id = announcement_id and public.is_org_manager(a.org_id)));

-- Who an announcement is for (active members only).
create or replace function public.announcement_recipients(p_id uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.user_id from public.announcements a join public.org_members m on m.org_id = a.org_id and m.status = 'active'
  where a.id = p_id and (
    a.audience = 'all'
    or (a.audience = 'people' and m.user_id = any(a.user_ids))
    or (a.audience = 'teams' and exists (select 1 from public.team_members tm where tm.user_id = m.user_id and tm.team_id = any(a.team_ids))))
$$;

create or replace function public.send_announcement(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can send announcements'; end if;
  if coalesce(trim(p->>'title'), '') = '' or coalesce(trim(p->>'body'), '') = '' then raise exception 'Write a title and a message'; end if;
  insert into public.announcements (org_id, title, body, urgent, audience, team_ids, user_ids, created_by)
  values (p_org, trim(p->>'title'), trim(p->>'body'), coalesce((p->>'urgent')::boolean, false), coalesce(p->>'audience', 'all'),
    coalesce(array(select jsonb_array_elements_text(p->'team_ids'))::uuid[], '{}'), coalesce(array(select jsonb_array_elements_text(p->'user_ids'))::uuid[], '{}'),
    auth.uid())
  returning id into v_id;
  insert into public.announcement_acks (announcement_id, user_id) select v_id, r from public.announcement_recipients(v_id) r
  on conflict do nothing;
  return v_id;
end $$;

-- The app: my announcements still waiting for my acknowledgement.
create or replace function public.my_announcements(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'urgent', a.urgent,
    'created_at', a.created_at, 'reminded_at', a.reminded_at, 'from', p.full_name) order by a.created_at), '[]'::jsonb)
  from public.announcement_acks k join public.announcements a on a.id = k.announcement_id
  left join public.profiles p on p.id = a.created_by
  where k.user_id = auth.uid() and k.acked_at is null and a.org_id = p_org and a.closed_at is null
$$;

create or replace function public.mark_announcement(p_id uuid, p_ack boolean)
returns void language sql security definer set search_path = '' as $$
  update public.announcement_acks set seen_at = coalesce(seen_at, now()), acked_at = case when p_ack then coalesce(acked_at, now()) else acked_at end
  where announcement_id = p_id and user_id = auth.uid()
$$;

-- Dashboard: announcements with acknowledgement counts.
create or replace function public.announcement_report(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'urgent', a.urgent, 'audience', a.audience,
      'created_at', a.created_at, 'reminded_at', a.reminded_at, 'closed_at', a.closed_at, 'by', a.created_by,
      'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', k.user_id, 'seen_at', k.seen_at, 'acked_at', k.acked_at)), '[]'::jsonb)
                 from public.announcement_acks k where k.announcement_id = a.id)) as x
    from public.announcements a where a.org_id = p_org order by a.created_at desc limit 100) t;
  return res;
end $$;

create or replace function public.remind_announcement(p_id uuid, p_close boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.announcements where id = p_id and public.is_org_manager(org_id)) then raise exception 'Not allowed'; end if;
  update public.announcements set reminded_at = case when p_close then reminded_at else now() end,
    closed_at = case when p_close then now() else closed_at end where id = p_id;
end $$;

-- ───────────── Numbers excluded from call tracking ─────────────
create table if not exists public.excluded_numbers (
  org_id uuid not null references public.organizations(id) on delete cascade,
  phone text not null,
  label text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, phone)
);
alter table public.excluded_numbers enable row level security;
drop policy if exists excluded_read on public.excluded_numbers;
create policy excluded_read on public.excluded_numbers for select using (public.is_org_manager(org_id));

create or replace function public.set_excluded_number(p_org uuid, p_phone text, p_label text, p_remove boolean default false)
returns int language plpgsql security definer set search_path = '' as $$
declare v_phone text; n int := 0;
begin
  if not public.is_org_admin(p_org) then raise exception 'Only admins can change this list'; end if;
  v_phone := public.normalize_phone(p_phone, (select phone_prefix from public.organizations where id = p_org));
  if v_phone is null or length(v_phone) < 8 then raise exception 'Not a valid phone number'; end if;
  if p_remove then delete from public.excluded_numbers where org_id = p_org and phone = v_phone; return 0; end if;
  insert into public.excluded_numbers (org_id, phone, label, created_by) values (p_org, v_phone, nullif(trim(p_label), ''), auth.uid())
  on conflict (org_id, phone) do update set label = excluded.label;
  -- Remove calls with this number that were already uploaded (they were personal).
  delete from public.calls where org_id = p_org and phone = v_phone and lead_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────────── New leads assigned to me (app alert) ─────────────
create or replace function public.my_new_leads(p_org uuid, p_since timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('count', count(*), 'names', coalesce((array_agg(coalesce(nullif(l.name, ''), l.phone) order by l.assigned_at desc))[1:3], '{}'),
                            'latest', max(l.assigned_at))
  from public.leads l
  where l.org_id = p_org and l.assigned_to = auth.uid() and l.deleted_at is null and l.assigned_at > p_since
$$;

revoke execute on function public.announcement_recipients(uuid) from anon, public, authenticated;
do $$ declare f text; begin
  foreach f in array array['send_announcement(uuid, jsonb)', 'my_announcements(uuid)', 'mark_announcement(uuid, boolean)', 'announcement_report(uuid)',
    'remind_announcement(uuid, boolean)', 'set_excluded_number(uuid, text, text, boolean)', 'my_new_leads(uuid, timestamptz)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- sync_calls: skip excluded numbers.
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
    -- Numbers the company excluded (personal, family, office lines) are never uploaded.
    if v_phone <> '' and exists (select 1 from public.excluded_numbers x where x.org_id = p_org and x.phone = v_phone) then
      skipped := skipped + 1; continue;
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


