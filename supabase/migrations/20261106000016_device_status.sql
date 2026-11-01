-- Each phone reports its setup and recording status, so managers (and support) can see why a
-- phone isn't uploading recordings: wrong phone app, folder not chosen, no files found, errors.
create table if not exists public.device_status (
  device_id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  model text, android text, app_version text, default_dialer text,
  rec_folder_set boolean not null default false,
  rec_files_found int, rec_calls_checked int, rec_matched int, rec_uploaded_total int,
  rec_last_error text, rec_checked_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists device_status_org_idx on public.device_status (org_id);
alter table public.device_status enable row level security;
drop policy if exists device_status_read on public.device_status;
create policy device_status_read on public.device_status for select using (
  user_id = auth.uid() or (public.is_org_member(org_id) and public.can_see_user(org_id, user_id))
);

create or replace function public.report_device_status(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (p->>'org_id')::uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member'; end if;
  insert into public.device_status as d (device_id, org_id, user_id, model, android, app_version, default_dialer, rec_folder_set,
    rec_files_found, rec_calls_checked, rec_matched, rec_uploaded_total, rec_last_error, rec_checked_at, updated_at)
  values (p->>'device_id', v_org, auth.uid(), p->>'model', p->>'android', p->>'app_version', p->>'default_dialer',
    coalesce((p->>'rec_folder_set')::boolean, false), (p->>'rec_files_found')::int, (p->>'rec_calls_checked')::int,
    (p->>'rec_matched')::int, (p->>'rec_uploaded_total')::int, nullif(p->>'rec_last_error', ''),
    nullif(p->>'rec_checked_at', '')::timestamptz, now())
  on conflict (device_id) do update set org_id = excluded.org_id, user_id = excluded.user_id, model = excluded.model,
    android = excluded.android, app_version = excluded.app_version, default_dialer = excluded.default_dialer,
    rec_folder_set = excluded.rec_folder_set, rec_files_found = excluded.rec_files_found, rec_calls_checked = excluded.rec_calls_checked,
    rec_matched = excluded.rec_matched, rec_uploaded_total = excluded.rec_uploaded_total, rec_last_error = excluded.rec_last_error,
    rec_checked_at = excluded.rec_checked_at, updated_at = now();
end $$;
revoke execute on function public.report_device_status(jsonb) from anon, public;
grant execute on function public.report_device_status(jsonb) to authenticated;
