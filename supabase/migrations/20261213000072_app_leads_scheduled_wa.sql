-- App round (Nov 13): add / import leads from the app, scheduled WhatsApp messages, WhatsApp sequence details.

-- ── Add one lead from the app (any member; assigned to the person adding it) ──
-- Returns {id, existing}: an existing lead with the same number is returned instead of a duplicate.
create or replace function public.add_lead(p_org uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_phone text; v_id uuid; v_batch uuid := nullif(p->>'batch_id', '')::uuid;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  v_phone := public.normalize_phone(p->>'phone', v_prefix);
  if v_phone is null or length(v_phone) < 8 then raise exception 'Enter a valid phone number'; end if;
  select l.id into v_id from public.leads l where l.org_id = p_org and l.phone = v_phone and l.deleted_at is null;
  if v_id is null then select lp.lead_id into v_id from public.lead_phones lp where lp.org_id = p_org and lp.phone = v_phone; end if;
  if v_id is not null then
    if v_batch is not null and exists (select 1 from public.batches where id = v_batch and org_id = p_org) then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (v_batch, v_id, p_org, true) on conflict do nothing;
      update public.leads set updated_at = now() where id = v_id;
    end if;
    return jsonb_build_object('id', v_id, 'existing', true);
  end if;
  perform set_config('closeros.skip_distribution', 'on', true);
  insert into public.leads (org_id, name, phone, email, city, state, profession, company, notes, source, assigned_to)
  values (p_org, coalesce(trim(p->>'name'), ''), v_phone, nullif(lower(trim(p->>'email')), ''), nullif(trim(p->>'city'), ''),
    nullif(trim(p->>'state'), ''), nullif(trim(p->>'profession'), ''), nullif(trim(p->>'company'), ''), nullif(trim(p->>'notes'), ''),
    coalesce(nullif(trim(p->>'source'), ''), 'Added in app'), auth.uid())
  returning id into v_id;
  if v_batch is not null and exists (select 1 from public.batches where id = v_batch and org_id = p_org) then
    insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (v_batch, v_id, p_org, false) on conflict do nothing;
  end if;
  return jsonb_build_object('id', v_id, 'existing', false);
end $$;

-- ── Import a file from the app (any member; leads assigned to the person importing) ──
-- Numbers already in the company's list are not duplicated ("already" — joined to the event as Repeated when one is given).
create or replace function public.import_my_leads(p_org uuid, p_rows jsonb, p_batch uuid default null, p_source text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prefix text; r jsonb; v_phone text; v_id uuid; v_ins int := 0; v_already int := 0; v_bad int := 0; v_joined int := 0; v_seen text[] := '{}';
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then raise exception 'Unknown event'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  perform set_config('closeros.skip_distribution', 'on', true);
  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;
    if v_phone = any(v_seen) then v_already := v_already + 1; continue; end if;
    v_seen := v_seen || v_phone;
    v_id := null;
    select l.id into v_id from public.leads l where l.org_id = p_org and l.phone = v_phone and l.deleted_at is null;
    if v_id is null then select lp.lead_id into v_id from public.lead_phones lp where lp.org_id = p_org and lp.phone = v_phone; end if;
    if v_id is not null then
      v_already := v_already + 1;
      if p_batch is not null then
        insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_id, p_org, true) on conflict do nothing;
        if found then v_joined := v_joined + 1; update public.leads set updated_at = now() where id = v_id; end if;
      end if;
      continue;
    end if;
    insert into public.leads (org_id, name, phone, email, city, state, profession, company, notes, source, campaign, assigned_to)
    values (p_org, coalesce(trim(r->>'name'), ''), v_phone, nullif(lower(trim(r->>'email')), ''), nullif(trim(r->>'city'), ''),
      nullif(trim(r->>'state'), ''), nullif(trim(r->>'profession'), ''), nullif(trim(r->>'company'), ''), nullif(trim(r->>'notes'), ''),
      coalesce(nullif(trim(r->>'source'), ''), p_source, 'Imported in app'), nullif(trim(r->>'campaign'), ''), auth.uid())
    returning id into v_id;
    if p_batch is not null then insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_id, p_org, false) on conflict do nothing; end if;
    v_ins := v_ins + 1;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'already', v_already, 'joined', v_joined, 'invalid', v_bad);
end $$;

-- ── Scheduled WhatsApp messages (one message to one lead at a set time; sent with one tap) ──
create table if not exists public.wa_scheduled (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  due_at timestamptz not null,
  body text not null default '',
  media_path text, media_type text, media_name text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled')),
  done_at timestamptz,
  wa_message_id uuid references public.wa_messages(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists wa_scheduled_due on public.wa_scheduled (org_id, user_id, due_at) where status = 'pending';
create index if not exists wa_scheduled_lead on public.wa_scheduled (lead_id);
alter table public.wa_scheduled enable row level security;
drop policy if exists wa_sched_read on public.wa_scheduled;
create policy wa_sched_read on public.wa_scheduled for select to authenticated using (user_id = auth.uid() or public.can_see_user(org_id, user_id));

create or replace function public.schedule_wa(p_lead uuid, p_due timestamptz, p_body text, p_media jsonb default null, p_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  select org_id into v_org from public.leads where id = p_lead;
  if v_org is null or not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  if coalesce(trim(p_body), '') = '' and coalesce(p_media->>'path', '') = '' then raise exception 'Write the message first'; end if;
  if p_id is not null then
    update public.wa_scheduled set due_at = p_due, body = coalesce(p_body, ''), media_path = nullif(p_media->>'path', ''),
      media_type = nullif(p_media->>'type', ''), media_name = nullif(p_media->>'name', '')
    where id = p_id and user_id = auth.uid() and status = 'pending' returning id into v_id;
    if v_id is null then raise exception 'Scheduled message not found'; end if;
    return v_id;
  end if;
  insert into public.wa_scheduled (org_id, lead_id, due_at, body, media_path, media_type, media_name)
  values (v_org, p_lead, p_due, coalesce(p_body, ''), nullif(p_media->>'path', ''), nullif(p_media->>'type', ''), nullif(p_media->>'name', ''))
  returning id into v_id;
  return v_id;
end $$;

-- sent = true → counted as a WhatsApp message (source 'scheduled'); false = cancel.
create or replace function public.wa_scheduled_mark(p_id uuid, p_sent boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare s record; v_wa uuid; v_phone text;
begin
  select * into s from public.wa_scheduled where id = p_id;
  if s is null or s.user_id <> auth.uid() then raise exception 'Not allowed'; end if;
  if s.status <> 'pending' then return; end if;
  if p_sent then
    select phone into v_phone from public.leads where id = s.lead_id;
    insert into public.wa_messages (org_id, lead_id, user_id, phone, template_name, source)
    values (s.org_id, s.lead_id, auth.uid(), coalesce(v_phone, ''), 'Scheduled message', 'scheduled') returning id into v_wa;
  end if;
  update public.wa_scheduled set status = case when p_sent then 'sent' else 'cancelled' end, done_at = now(), wa_message_id = v_wa where id = p_id;
end $$;

-- My scheduled messages (pending), soonest first, with the lead.
create or replace function public.my_wa_scheduled(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'lead_id', s.lead_id, 'lead_name', l.name, 'phone', l.phone, 'due_at', s.due_at,
    'body', s.body, 'media_path', s.media_path, 'media_type', s.media_type, 'media_name', s.media_name) order by s.due_at), '[]')
  from public.wa_scheduled s join public.leads l on l.id = s.lead_id
  where s.org_id = p_org and s.user_id = auth.uid() and s.status = 'pending' and public.is_org_member(p_org)
$$;

-- A lead's pending scheduled messages (lead page).
create or replace function public.lead_wa_scheduled(p_lead uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'due_at', s.due_at, 'body', s.body, 'media_name', s.media_name,
    'mine', s.user_id = auth.uid()) order by s.due_at), '[]')
  from public.wa_scheduled s where s.lead_id = p_lead and s.status = 'pending' and public.lead_visible(p_lead)
$$;

-- Messages due now = sequence messages + scheduled messages (kind 'sequence' | 'scheduled').
create or replace function public.my_sequence_due(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_end timestamptz; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_end := ((now() at time zone v_tz)::date + 1)::timestamp at time zone v_tz;
  select jsonb_build_object(
    'due', coalesce((select jsonb_agg(r order by r->>'due_at') from (
      select jsonb_build_object('id', e.id, 'kind', 'sequence', 'sequence_id', s.id, 'sequence', s.name, 'position', m.position,
        'total', (select count(*) from public.wa_sequence_messages x where x.sequence_id = s.id),
        'due_at', e.next_due_at, 'body', m.body, 'media_path', m.media_path, 'media_type', m.media_type, 'media_name', m.media_name,
        'lead', to_jsonb(l) || jsonb_build_object('batch_leads', coalesce((
          select jsonb_agg(jsonb_build_object('batch_id', b.id, 'batch', jsonb_build_object('name', b.name, 'webinar_at', b.webinar_at)))
          from public.batches b where b.id = e.batch_id), '[]'))) r
      from public.wa_sequence_leads e
      join public.wa_sequences s on s.id = e.sequence_id
      join public.wa_sequence_messages m on m.sequence_id = e.sequence_id and m.position = e.next_pos
      join public.leads l on l.id = e.lead_id
      where e.org_id = p_org and e.user_id = auth.uid() and e.status = 'active' and e.next_due_at <= now()
      union all
      select jsonb_build_object('id', w.id, 'kind', 'scheduled', 'sequence_id', null, 'sequence', 'Scheduled message', 'position', 1, 'total', 1,
        'due_at', w.due_at, 'body', w.body, 'media_path', w.media_path, 'media_type', w.media_type, 'media_name', w.media_name,
        'lead', to_jsonb(l) || jsonb_build_object('batch_leads', '[]'::jsonb))
      from public.wa_scheduled w join public.leads l on l.id = w.lead_id
      where w.org_id = p_org and w.user_id = auth.uid() and w.status = 'pending' and w.due_at <= now()
      limit 500) q), '[]'),
    'later_today', (select count(*) from public.wa_sequence_leads e where e.org_id = p_org and e.user_id = auth.uid()
      and e.status = 'active' and e.next_due_at > now() and e.next_due_at < v_end)
      + (select count(*) from public.wa_scheduled w where w.org_id = p_org and w.user_id = auth.uid() and w.status = 'pending'
      and w.due_at > now() and w.due_at < v_end)
  ) into res;
  return res;
end $$;

-- ── WhatsApp sequence details: stats + the leads on it ──
-- Individuals: the owner. Teams: managers see everyone's leads on it; a rep sees their own.
create or replace function public.sequence_detail(p_seq uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s record; v_tz text; v_today_end timestamptz; res jsonb;
begin
  select * into s from public.wa_sequences where id = p_seq;
  if s is null or not public.is_org_member(s.org_id)
     or not (s.owner_id is null or s.owner_id = auth.uid() or public.can_see_user(s.org_id, s.owner_id)) then raise exception 'Sequence not found'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = s.org_id;
  v_today_end := ((now() at time zone v_tz)::date + 1)::timestamp at time zone v_tz;
  with e as (
    select e.* from public.wa_sequence_leads e
    where e.sequence_id = p_seq and (e.user_id = auth.uid() or public.can_see_user(e.org_id, e.user_id))
  ), x as (
    select x.* from public.wa_sequence_sends x where x.enrollment_id in (select id from e)
  )
  select jsonb_build_object(
    'stats', jsonb_build_object(
      'active', (select count(*) from e where status = 'active'),
      'paused', (select count(*) from e where status = 'paused'),
      'done', (select count(*) from e where status = 'done'),
      'stopped', (select count(*) from e where status = 'stopped'),
      'due_today', (select count(*) from e where status = 'active' and next_due_at < v_today_end),
      'sent_on_time', (select count(*) from x where status = 'sent' and (done_at at time zone v_tz)::date <= (due_at at time zone v_tz)::date),
      'sent_late', (select count(*) from x where status = 'sent' and (done_at at time zone v_tz)::date > (due_at at time zone v_tz)::date),
      'skipped', (select count(*) from x where status = 'skipped'),
      'bought', (select count(*) from e join public.leads l on l.id = e.lead_id where l.won_at is not null and l.won_at >= e.started_at)),
    'leads', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'lead_id', e.lead_id, 'name', l.name, 'phone', l.phone,
        'status', e.status, 'stop_reason', e.stop_reason, 'next_pos', e.next_pos, 'next_due_at', e.next_due_at, 'sent_count', e.sent_count,
        'started_at', e.started_at, 'user_id', e.user_id, 'user_name', (select full_name from public.profiles p where p.id = e.user_id),
        'bought', l.won_at is not null and l.won_at >= e.started_at)
      order by (e.status = 'active') desc, (e.status = 'paused') desc, e.next_due_at nulls last, e.started_at desc)
      from (select * from e order by started_at desc limit 2000) e join public.leads l on l.id = e.lead_id), '[]'),
    'total', (select count(*) from public.wa_sequence_messages where sequence_id = p_seq)
  ) into res;
  return res;
end $$;

-- Pause / resume / remove several leads at once.
create or replace function public.set_sequence_leads(p_ids uuid[], p_action text)
returns int language plpgsql security definer set search_path = '' as $$
declare v uuid; n int := 0;
begin
  foreach v in array coalesce(p_ids, '{}') loop
    begin perform public.set_sequence_lead(v, p_action); n := n + 1; exception when others then null; end;
  end loop;
  return n;
end $$;

revoke execute on function public.add_lead(uuid, jsonb), public.import_my_leads(uuid, jsonb, uuid, text),
  public.schedule_wa(uuid, timestamptz, text, jsonb, uuid), public.wa_scheduled_mark(uuid, boolean), public.my_wa_scheduled(uuid),
  public.lead_wa_scheduled(uuid), public.sequence_detail(uuid), public.set_sequence_leads(uuid[], text) from public, anon;
grant execute on function public.add_lead(uuid, jsonb), public.import_my_leads(uuid, jsonb, uuid, text),
  public.schedule_wa(uuid, timestamptz, text, jsonb, uuid), public.wa_scheduled_mark(uuid, boolean), public.my_wa_scheduled(uuid),
  public.lead_wa_scheduled(uuid), public.sequence_detail(uuid), public.set_sequence_leads(uuid[], text) to authenticated;
