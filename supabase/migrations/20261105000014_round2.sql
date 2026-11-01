-- Owner feedback round 2:
--  • WhatsApp message templates per company (rep picks one; variables filled per lead)
--  • leads.last_connected_at (last call where both sides talked)
--  • call recordings: private storage bucket, upload registration, playback audit

-- ───────────── WhatsApp templates ─────────────
create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  body text not null,
  position int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists message_templates_org_idx on public.message_templates (org_id, position);
alter table public.message_templates enable row level security;
drop policy if exists templates_select on public.message_templates;
create policy templates_select on public.message_templates for select using (public.is_org_member(org_id));
drop policy if exists templates_write on public.message_templates;
create policy templates_write on public.message_templates for all using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));

create or replace function public.seed_templates(p_org uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.message_templates (org_id, name, body, position)
  select p_org, x.name, x.body, x.pos from (values
    ('After the call', 'Hi {{leadName}}, this is {{repName}} from {{companyName}}. It was great speaking with you just now. As discussed, here are the details. Feel free to message me here if you have any questions.', 1),
    ('Webinar reminder', 'Hi {{leadName}}, a quick reminder about {{batchName}} on {{batchDate}}. Please join on time — it will be really useful for you. See you there! — {{repName}}, {{companyName}}', 2),
    ('Could not reach you', 'Hi {{leadName}}, I tried calling you a little while ago but couldn''t reach you. When is a good time to talk? — {{repName}}, {{companyName}}', 3),
    ('Follow-up', 'Hi {{leadName}}, following up on our conversation. Shall we speak at {{followUpTime}}? — {{repName}}', 4),
    ('Payment details', 'Hi {{leadName}}, as discussed, here is the link to complete your enrolment: [add your payment link]. Let me know once done. — {{repName}}, {{companyName}}', 5)
  ) as x(name, body, pos)
  where not exists (select 1 from public.message_templates where org_id = p_org)
$$;
do $$ declare o record; begin for o in select id from public.organizations loop perform public.seed_templates(o.id); end loop; end $$;

create or replace function public.after_org_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.seed_org_defaults(new.id); perform public.seed_templates(new.id); return new; end $$;

-- ───────────── Last conversation per lead ─────────────
alter table public.leads add column if not exists last_connected_at timestamptz;
create or replace function public.mark_lead_connected()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.lead_id is not null and new.duration_sec > 0 and new.direction in ('incoming', 'outgoing') then
    update public.leads set last_connected_at = greatest(coalesce(last_connected_at, '-infinity'), new.started_at) where id = new.lead_id;
  end if;
  return new;
end $$;
drop trigger if exists t_call_lead_connected on public.calls;
create trigger t_call_lead_connected after insert or update of duration_sec, lead_id on public.calls
  for each row execute function public.mark_lead_connected();
update public.leads l set last_connected_at = x.at from (
  select lead_id, max(started_at) at from public.calls where lead_id is not null and duration_sec > 0 group by lead_id
) x where x.lead_id = l.id;

-- ───────────── Call recordings ─────────────
-- Files live in a PRIVATE bucket at <org_id>/<user_id>/<call_id>.<ext>. Reps upload their own;
-- whoever may see the call may get a short-lived signed link to play it.
insert into storage.buckets (id, name, public, file_size_limit)
values ('recordings', 'recordings', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists recordings_insert on storage.objects;
create policy recordings_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'recordings'
  and (storage.foldername(name))[2] = auth.uid()::text
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);
drop policy if exists recordings_update on storage.objects;
create policy recordings_update on storage.objects for update to authenticated using (
  bucket_id = 'recordings' and (storage.foldername(name))[2] = auth.uid()::text
);
drop policy if exists recordings_select on storage.objects;
create policy recordings_select on storage.objects for select to authenticated using (
  bucket_id = 'recordings' and exists (
    select 1 from public.calls c
    where c.recording_path = storage.objects.name and public.is_org_member(c.org_id) and public.can_see_user(c.org_id, c.user_id)
  )
);

-- The phone calls this after uploading a file for one of its calls.
create or replace function public.set_call_recording(p_call uuid, p_path text, p_size bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.calls set recording_status = 'uploaded', recording_path = p_path, recording_size_bytes = p_size
  where id = p_call and user_id = auth.uid() and p_path like org_id::text || '/' || auth.uid()::text || '/%';
  if not found then raise exception 'Call not found'; end if;
end $$;

-- Calls with talk time but no recording after 6 hours count as "missing" (unless recording is off).
create or replace function public.mark_missing_recordings(p_org uuid)
returns int language sql security definer set search_path = '' as $$
  with u as (
    update public.calls set recording_status = 'missing'
    where org_id = p_org and duration_sec > 0 and direction in ('incoming', 'outgoing')
      and recording_status in ('not_expected', 'pending') and started_at < now() - interval '6 hours'
      and started_at > now() - interval '30 days'
      and exists (select 1 from public.calls x where x.org_id = p_org and x.user_id = calls.user_id and x.recording_status = 'uploaded')
    returning 1)
  select count(*)::int from u
$$;

-- Every time a manager plays or downloads a recording, it is written to the audit log.
create or replace function public.log_recording_access(p_call uuid, p_action text default 'play')
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_user uuid;
begin
  select org_id, user_id into v_org, v_user from public.calls where id = p_call;
  if v_org is null or not public.can_see_user(v_org, v_user) then raise exception 'Not allowed'; end if;
  perform public.write_audit(v_org, 'recording.' || p_action, 'call', p_call::text, '{}'::jsonb);
end $$;

revoke execute on function public.set_call_recording(uuid, text, bigint) from anon, public;
revoke execute on function public.mark_missing_recordings(uuid) from anon, public;
revoke execute on function public.log_recording_access(uuid, text) from anon, public;
revoke execute on function public.seed_templates(uuid) from anon, public, authenticated;
grant execute on function public.set_call_recording(uuid, text, bigint) to authenticated;
grant execute on function public.mark_missing_recordings(uuid) to authenticated;
grant execute on function public.log_recording_access(uuid, text) to authenticated;
