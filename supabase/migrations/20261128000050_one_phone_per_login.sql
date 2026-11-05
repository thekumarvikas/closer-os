-- One login = one phone at a time. Signing in on a phone makes it the active phone; any other phone
-- with the same login signs itself out the next time it is online (after uploading what it saved).
-- The web dashboard is not affected.
alter table public.profiles add column if not exists active_device text;
alter table public.profiles add column if not exists active_device_name text;
alter table public.profiles add column if not exists active_device_at timestamptz;

create or replace function public.claim_device(p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select active_device_name into v_prev from public.profiles where id = auth.uid() and active_device is distinct from p_device;
  update public.profiles set active_device = p_device, active_device_name = nullif(trim(p_name), ''), active_device_at = now() where id = auth.uid();
  return jsonb_build_object('signed_out_other', v_prev);
end $$;

create or replace function public.device_check(p_device text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select active_device, active_device_name, active_device_at into r from public.profiles where id = auth.uid();
  if r.active_device is null then   -- phones signed in before this rule: the first one to check keeps the login
    update public.profiles set active_device = p_device, active_device_name = nullif(trim(p_name), ''), active_device_at = now() where id = auth.uid();
    return jsonb_build_object('active', true);
  end if;
  return jsonb_build_object('active', r.active_device = p_device, 'other', r.active_device_name, 'since', r.active_device_at);
end $$;

grant execute on function public.claim_device(text, text), public.device_check(text, text) to authenticated;
