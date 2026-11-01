-- Each phone also reports its setup checklist (which permissions/settings are on), so managers can
-- see which rep still has something switched off.
alter table public.device_status add column if not exists setup jsonb;

create or replace function public.report_device_status(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (p->>'org_id')::uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member'; end if;
  insert into public.device_status as d (device_id, org_id, user_id, model, android, app_version, default_dialer, rec_folder_set,
    rec_files_found, rec_calls_checked, rec_matched, rec_uploaded_total, rec_last_error, rec_checked_at, setup, updated_at)
  values (p->>'device_id', v_org, auth.uid(), p->>'model', p->>'android', p->>'app_version', p->>'default_dialer',
    coalesce((p->>'rec_folder_set')::boolean, false), (p->>'rec_files_found')::int, (p->>'rec_calls_checked')::int,
    (p->>'rec_matched')::int, (p->>'rec_uploaded_total')::int, nullif(p->>'rec_last_error', ''),
    nullif(p->>'rec_checked_at', '')::timestamptz, p->'setup', now())
  on conflict (device_id) do update set org_id = excluded.org_id, user_id = excluded.user_id, model = excluded.model,
    android = excluded.android, app_version = excluded.app_version, default_dialer = excluded.default_dialer,
    rec_folder_set = excluded.rec_folder_set, rec_files_found = excluded.rec_files_found, rec_calls_checked = excluded.rec_calls_checked,
    rec_matched = excluded.rec_matched, rec_uploaded_total = excluded.rec_uploaded_total, rec_last_error = excluded.rec_last_error,
    rec_checked_at = excluded.rec_checked_at, setup = coalesce(excluded.setup, d.setup), updated_at = now();
end $$;
