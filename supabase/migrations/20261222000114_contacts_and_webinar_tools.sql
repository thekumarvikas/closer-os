-- Owner round (Nov 21 2026): several numbers + emails per lead with labels, names used at registration,
-- webinar show-up by source, "share out" only when needed, undo last Zoom upload.

-- ── Numbers & emails ──
alter table public.leads add column if not exists phone_label text not null default 'Primary',
  add column if not exists email_label text not null default 'Primary';
alter table public.lead_phones add column if not exists source text;
update public.lead_phones set label = 'Secondary', source = coalesce(source, 'Came in again with this number')
  where label = 'Came in again with this number';
alter table public.lead_phones alter column label set default 'Secondary';

create table if not exists public.lead_emails (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  email text not null, email_key text, label text not null default 'Secondary', source text,
  created_at timestamptz not null default now(), unique (lead_id, email));
create index if not exists lead_emails_org_key on public.lead_emails (org_id, email_key);
alter table public.lead_emails enable row level security;
drop policy if exists lead_emails_select on public.lead_emails;
create policy lead_emails_select on public.lead_emails for select using (public.lead_visible(lead_id));

-- find_lead also knows extra emails.
create or replace function public.find_lead(p_org uuid, p_phone text, p_email text default null)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid; k text := public.phone_key(p_phone); e text := public.email_key(p_email);
begin
  if p_phone is not null then
    select id into v from public.leads where org_id = p_org and phone = p_phone and deleted_at is null limit 1;
    if v is not null then return v; end if;
    select lead_id into v from public.lead_phones where org_id = p_org and phone = p_phone limit 1;
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
end $$;

-- lead_arrived keeps a new number AND a new email (labelled Secondary, with where it came from).
create or replace function public.lead_arrived(p_lead uuid, p_kind text, p_source text, p_campaign text, p_batch uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.leads; v_prefix text; v_phone text; v_email text; d jsonb := coalesce(p_data, '{}'::jsonb); v_from text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return; end if;
  select phone_prefix into v_prefix from public.organizations where id = l.org_id;
  v_phone := public.normalize_phone(d->>'phone', v_prefix);
  v_email := public.clean_email(d->>'email');
  v_from := coalesce(nullif(trim(p_source), ''), initcap(coalesce(p_kind, 'other')));
  insert into public.lead_origins (org_id, lead_id, kind, source, campaign, batch_id, user_id, data)
  values (l.org_id, l.id, coalesce(p_kind, 'other'), nullif(trim(p_source), ''), nullif(trim(p_campaign), ''), p_batch, auth.uid(),
    jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(d->>'name'), ''), 'email', v_email, 'phone', v_phone)));
  update public.leads set arrivals = arrivals + 1, last_arrived_at = now(), updated_at = now(),
    name = case when coalesce(trim(name), '') = '' then coalesce(nullif(trim(d->>'name'), ''), name) else name end,
    email = coalesce(email, v_email),
    city = coalesce(city, nullif(trim(d->>'city'), '')),
    state = coalesce(state, nullif(trim(d->>'state'), '')),
    profession = coalesce(profession, nullif(trim(d->>'profession'), '')),
    company = coalesce(company, nullif(trim(d->>'company'), ''))
  where id = l.id;
  if v_phone is not null and length(v_phone) >= 8 and v_phone <> l.phone
     and public.phone_key(v_phone) is distinct from l.phone_key
     and not exists (select 1 from public.lead_phones where org_id = l.org_id and public.phone_key(phone) = public.phone_key(v_phone)) then
    insert into public.lead_phones (org_id, lead_id, phone, label, source) values (l.org_id, l.id, v_phone, 'Secondary', v_from)
    on conflict do nothing;
  end if;
  if v_email is not null and position('@' in v_email) > 1 and l.email is not null
     and public.email_key(v_email) is distinct from public.email_key(l.email)
     and not exists (select 1 from public.lead_emails where lead_id = l.id and email_key = public.email_key(v_email)) then
    insert into public.lead_emails (org_id, lead_id, email, email_key, label, source)
    values (l.org_id, l.id, v_email, public.email_key(v_email), 'Secondary', v_from) on conflict do nothing;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'repeated', jsonb_strip_nulls(jsonb_build_object('source', nullif(trim(p_source), ''),
    'campaign', nullif(trim(p_campaign), ''), 'batch_id', p_batch, 'via', p_kind)));
  if p_batch is not null and coalesce(p_source, '') <> 'Zoom attendee' then
    update public.batch_leads set registered = true where batch_id = p_batch and lead_id = l.id and not registered;
  end if;
end $$;

-- Backfill extra emails from earlier arrivals.
insert into public.lead_emails (org_id, lead_id, email, email_key, label, source)
select distinct on (o.lead_id, public.email_key(o.data->>'email')) o.org_id, o.lead_id, o.data->>'email', public.email_key(o.data->>'email'), 'Secondary',
  coalesce(o.source, initcap(o.kind))
from public.lead_origins o join public.leads l on l.id = o.lead_id
where o.data->>'email' is not null and l.email is not null and public.email_key(o.data->>'email') is distinct from public.email_key(l.email)
on conflict do nothing;

-- Everything about how to reach a lead: numbers, emails, other names used.
create or replace function public.lead_contacts(p_lead uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.lead_visible(l.id) then null else jsonb_build_object(
    'phones', jsonb_build_array(jsonb_build_object('id', null, 'value', l.phone, 'label', l.phone_label, 'main', true, 'source', l.source, 'at', l.created_at))
      || coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'value', p.phone, 'label', p.label, 'main', false, 'source', p.source, 'at', p.created_at) order by p.created_at)
                   from public.lead_phones p where p.lead_id = l.id), '[]'),
    'emails', case when l.email is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('id', null, 'value', l.email, 'label', l.email_label, 'main', true)) end
      || coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'value', e.email, 'label', e.label, 'main', false, 'source', e.source, 'at', e.created_at) order by e.created_at)
                   from public.lead_emails e where e.lead_id = l.id), '[]'),
    'names', coalesce((select jsonb_agg(jsonb_build_object('name', n.name, 'at', n.at, 'source', n.source) order by n.at) from (
        select distinct on (lower(trim(o.data->>'name'))) trim(o.data->>'name') name, o.at, o.source
        from public.lead_origins o where o.lead_id = l.id and coalesce(trim(o.data->>'name'), '') <> ''
          and lower(trim(o.data->>'name')) <> lower(trim(coalesce(l.name, '')))
        order by lower(trim(o.data->>'name')), o.at) n), '[]'),
    'can_remove', public.is_org_manager(l.org_id)) end
  from public.leads l where l.id = p_lead
$$;
grant execute on function public.lead_contacts(uuid) to authenticated;

-- Add / rename / make main / remove a number or email. Anyone who sees the lead adds + renames; managers remove.
create or replace function public.set_lead_contact(p_lead uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.leads; v_kind text := p->>'kind'; v_op text := p->>'op'; v_id uuid := nullif(p->>'id', '')::uuid;
  v_label text := nullif(left(trim(coalesce(p->>'label', '')), 30), ''); v_val text; v_prefix text; v_other uuid; r record;
begin
  select * into l from public.leads where id = p_lead and deleted_at is null;
  if l.id is null or not public.lead_visible(l.id) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = l.org_id;
  if v_kind = 'phone' then
    if v_op = 'add' then
      v_val := public.normalize_phone(p->>'value', v_prefix);
      if v_val is null or not public.phone_is_valid(v_val) then raise exception 'That phone number doesn''t look right'; end if;
      v_other := public.find_lead(l.org_id, v_val, null);
      if v_other is not null and v_other <> l.id then
        raise exception 'This number belongs to another lead: %', (select coalesce(nullif(name, ''), phone) from public.leads where id = v_other);
      end if;
      if v_other = l.id then return jsonb_build_object('ok', true, 'already', true); end if;
      insert into public.lead_phones (org_id, lead_id, phone, label, source) values (l.org_id, l.id, v_val, coalesce(v_label, 'Secondary'),
        'Added by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'a team member'));
    elsif v_op = 'label' then
      if v_id is null then update public.leads set phone_label = coalesce(v_label, 'Primary') where id = l.id;
      else update public.lead_phones set label = coalesce(v_label, 'Secondary') where id = v_id and lead_id = l.id; end if;
    elsif v_op = 'main' then
      select * into r from public.lead_phones where id = v_id and lead_id = l.id;
      if r.id is null then raise exception 'Number not found'; end if;
      update public.lead_phones set phone = l.phone, label = l.phone_label, source = 'Was the main number' where id = r.id;
      update public.leads set phone = r.phone, phone_label = r.label where id = l.id;
    elsif v_op = 'remove' then
      if not public.is_org_manager(l.org_id) then raise exception 'Only managers can remove a number'; end if;
      delete from public.lead_phones where id = v_id and lead_id = l.id;
    end if;
  elsif v_kind = 'email' then
    if v_op = 'add' then
      v_val := public.clean_email(p->>'value');
      if v_val is null or position('@' in v_val) < 2 then raise exception 'That email doesn''t look right'; end if;
      if l.email is null then update public.leads set email = v_val where id = l.id;
      else insert into public.lead_emails (org_id, lead_id, email, email_key, label, source)
        values (l.org_id, l.id, v_val, public.email_key(v_val), coalesce(v_label, 'Secondary'),
          'Added by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'a team member')) on conflict do nothing; end if;
    elsif v_op = 'label' then
      if v_id is null then update public.leads set email_label = coalesce(v_label, 'Primary') where id = l.id;
      else update public.lead_emails set label = coalesce(v_label, 'Secondary') where id = v_id and lead_id = l.id; end if;
    elsif v_op = 'main' then
      select * into r from public.lead_emails where id = v_id and lead_id = l.id;
      if r.id is null then raise exception 'Email not found'; end if;
      update public.lead_emails set email = l.email, email_key = public.email_key(l.email), label = l.email_label, source = 'Was the main email' where id = r.id;
      update public.leads set email = r.email, email_label = r.label where id = l.id;
    elsif v_op = 'remove' then
      if not public.is_org_manager(l.org_id) then raise exception 'Only managers can remove an email'; end if;
      delete from public.lead_emails where id = v_id and lead_id = l.id;
    end if;
  else raise exception 'Unknown contact type'; end if;
  update public.leads set updated_at = now() where id = l.id;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'contact_changed', jsonb_strip_nulls(jsonb_build_object('kind', v_kind, 'op', v_op, 'label', v_label)));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.set_lead_contact(uuid, jsonb) to authenticated;

-- One lead, names that share no word at all → worth a look (family / office numbers).
create or replace function public.lead_name_conflicts(p_org uuid, p_limit int default 200)
returns table(lead_id uuid, name text, phone text, other_names text[])
language sql stable security definer set search_path = '' as $$
  select l.id, l.name, l.phone, array_agg(distinct trim(o.data->>'name'))
  from public.leads l join public.lead_origins o on o.lead_id = l.id
  where l.org_id = p_org and l.deleted_at is null and public.is_org_manager(p_org)
    and coalesce(trim(o.data->>'name'), '') <> '' and coalesce(trim(l.name), '') <> ''
    and not exists (select 1 from regexp_split_to_table(lower(l.name), '[^[:alnum:]]+') a
                    join regexp_split_to_table(lower(o.data->>'name'), '[^[:alnum:]]+') b on a = b and length(a) >= 3)
    and not coalesce((l.custom->>'_names_ok')::boolean, false)
  group by l.id
  order by max(o.at) desc limit p_limit
$$;
grant execute on function public.lead_name_conflicts(uuid, int) to authenticated;

create or replace function public.lead_names_ok(p_lead uuid) returns void language sql security definer set search_path = '' as $$
  update public.leads set custom = coalesce(custom, '{}'::jsonb) || '{"_names_ok": true}'::jsonb
  where id = p_lead and public.is_org_manager(org_id)
$$;
grant execute on function public.lead_names_ok(uuid) to authenticated;

-- ── Webinars ──
-- Show-up by source: Landing page (registered from the sheet / form / import) vs Direct Zoom link (only in the Zoom file).
create or replace function public.batch_source_showup(p_batch uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'reg', count(*) filter (where coalesce(bl.registered, true)),
    'reg_joined', count(*) filter (where coalesce(bl.registered, true) and (coalesce(bl.watch_minutes, 0) > 0 or bl.attended)),
    'direct', count(*) filter (where not coalesce(bl.registered, true)),
    'direct_joined', count(*) filter (where not coalesce(bl.registered, true) and (coalesce(bl.watch_minutes, 0) > 0 or bl.attended)),
    'uploaded', (select zoom_uploaded_at is not null from public.batches where id = p_batch))
  from public.batch_leads bl join public.batches b on b.id = bl.batch_id
  join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  where bl.batch_id = p_batch and public.is_org_manager(b.org_id)
$$;
grant execute on function public.batch_source_showup(uuid) to authenticated;

-- Undo the last Zoom upload (for a day): a snapshot of the webinar's rows taken just before the upload.
create table if not exists public.zoom_upload_snapshots (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.batches(id) on delete cascade,
  org_id uuid not null, taken_at timestamptz not null default now(), taken_by uuid,
  batch jsonb not null, rows jsonb not null, undone_at timestamptz);
alter table public.zoom_upload_snapshots enable row level security;

create or replace function public.zoom_upload_begin(p_batch uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.batches; v uuid;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null or not public.is_org_manager(b.org_id) then raise exception 'Not allowed'; end if;
  insert into public.zoom_upload_snapshots (batch_id, org_id, taken_by, batch, rows)
  values (b.id, b.org_id, auth.uid(), to_jsonb(b), coalesce((select jsonb_agg(to_jsonb(bl)) from public.batch_leads bl where bl.batch_id = b.id), '[]'))
  returning id into v;
  delete from public.zoom_upload_snapshots where batch_id = b.id and id <> v and taken_at < now() - interval '2 days';
  return v;
end $$;
grant execute on function public.zoom_upload_begin(uuid) to authenticated;

create or replace function public.zoom_upload_last(p_batch uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'taken_at', s.taken_at) from public.zoom_upload_snapshots s join public.batches b on b.id = s.batch_id
  where s.batch_id = p_batch and s.undone_at is null and s.taken_at > now() - interval '24 hours' and public.is_org_manager(b.org_id)
  order by s.taken_at desc limit 1
$$;
grant execute on function public.zoom_upload_last(uuid) to authenticated;

create or replace function public.zoom_upload_undo(p_snapshot uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.zoom_upload_snapshots; v_removed int; v_leads int := 0;
begin
  select * into s from public.zoom_upload_snapshots where id = p_snapshot and undone_at is null and taken_at > now() - interval '24 hours';
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'This upload can no longer be undone'; end if;
  -- leads the upload created (from the Zoom file, never called, only in this webinar) go away again
  with gone as (
    update public.leads l set deleted_at = now() where l.org_id = s.org_id and l.deleted_at is null and l.created_at >= s.taken_at
      and l.source = 'Zoom attendee' and coalesce(l.call_count, 0) = 0
      and exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and bl.batch_id = s.batch_id)
      and not exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and bl.batch_id <> s.batch_id)
    returning 1) select count(*) into v_leads from gone;
  update public.batches set started_at = (s.batch->>'started_at')::timestamptz, zoom_uploaded_at = (s.batch->>'zoom_uploaded_at')::timestamptz
  where id = s.batch_id;
  delete from public.batch_leads where batch_id = s.batch_id;
  get diagnostics v_removed = row_count;
  insert into public.batch_leads select * from jsonb_populate_recordset(null::public.batch_leads, s.rows) on conflict do nothing;
  update public.zoom_upload_snapshots set undone_at = now() where id = s.id;
  perform public.batch_recompute(s.batch_id);
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
  values (s.org_id, auth.uid(), 'batch.zoom_undone', 'batch', s.batch_id, jsonb_build_object('snapshot', s.id, 'leads_removed', v_leads));
  return jsonb_build_object('ok', true, 'restored', jsonb_array_length(s.rows), 'leads_removed', v_leads);
end $$;
grant execute on function public.zoom_upload_undo(uuid) to authenticated;
drop function if exists public.batch_cards(uuid);
create function public.batch_cards(p_org uuid)
returns table(id uuid, name text, kind text, webinar_at timestamptz, auto_created boolean, zoom_uploaded boolean, registered int,
  assigned int, unassigned int, called int, attended int, hot int, repeats int, rem_called int, rem_talked int, rem_calls int,
  rem_by jsonb, again int, outside_rule int, share_needed int)
language sql stable security definer set search_path = '' as $$
  with rc as (
    select c.batch_id, c.lead_id, c.user_id, c.duration_sec from public.calls c
    join public.batches b on b.id = c.batch_id
    where c.org_id = p_org and c.purpose = 'reminder' and not b.is_archived and c.started_at < b.webinar_at
  ), anyc as (
    select distinct c.batch_id, c.lead_id from public.calls c join public.batches b on b.id = c.batch_id
    where c.org_id = p_org and not b.is_archived
  ), per as (
    select batch_id, user_id, count(distinct lead_id) leads, count(*) calls,
      count(distinct lead_id) filter (where duration_sec > 30) talked from rc group by 1, 2
  )
  select b.id, b.name, b.kind, b.webinar_at, b.auto_created, b.zoom_uploaded_at is not null,
    count(l.id)::int,
    count(l.id) filter (where l.assigned_to is not null)::int,
    count(l.id) filter (where l.assigned_to is null)::int,
    count(l.id) filter (where exists (select 1 from anyc where anyc.batch_id = b.id and anyc.lead_id = l.id))::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) > 0 or coalesce(bl.attended, false))::int,
    count(l.id) filter (where coalesce(bl.watch_minutes, 0) >= b.hot_minutes or coalesce(bl.warmth, 0) >= 70)::int,
    count(l.id) filter (where bl.is_repeat)::int,
    count(l.id) filter (where exists (select 1 from rc where rc.batch_id = b.id and rc.lead_id = l.id))::int,
    count(l.id) filter (where exists (select 1 from rc where rc.batch_id = b.id and rc.lead_id = l.id and rc.duration_sec > 30))::int,
    (select count(*) from rc where rc.batch_id = b.id)::int,
    coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'leads', p.leads, 'calls', p.calls, 'talked', p.talked) order by p.leads desc)
      from per p where p.batch_id = b.id), '[]'),
    count(l.id) filter (where l.reg_count >= 2)::int,
    count(l.id) filter (where bl.outside_rule and l.assigned_to = bl.reminder_by)::int,
    -- attendees still waiting for a sales caller: no owner, or still with someone on the reminder team while a sales team exists
    case when b.zoom_uploaded_at is null then 0 else (count(l.id) filter (where coalesce(bl.watch_minutes, 0) > 0 and (l.assigned_to is null
      or (exists (select 1 from public.org_members s where s.org_id = p_org and s.status = 'active' and s.call_team = 'sales')
          and exists (select 1 from public.org_members r where r.org_id = p_org and r.user_id = l.assigned_to and r.call_team = 'reminder')))))::int end
  from public.batches b
  left join public.batch_leads bl on bl.batch_id = b.id and not coalesce(bl.is_holdout, false)
  left join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  where b.org_id = p_org and not b.is_archived and public.is_org_manager(p_org)
  group by b.id
  order by b.webinar_at desc
$$;
grant execute on function public.batch_cards(uuid) to authenticated;