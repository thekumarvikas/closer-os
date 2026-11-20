-- Firebase push: each phone tells Closer OS its push address; managers can wake team phones ("Sync now").
create table if not exists public.push_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  token text not null,
  app text not null default 'app',
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.push_tokens enable row level security;   -- no direct access; RPCs only

create or replace function public.save_push_token(p_device text, p_token text, p_app text default 'app') returns void
language sql security definer set search_path = '' as $$
  insert into public.push_tokens (user_id, device_id, token, app, updated_at)
  values (auth.uid(), p_device, p_token, coalesce(p_app, 'app'), now())
  on conflict (user_id, device_id) do update set token = excluded.token, app = excluded.app, updated_at = now();
  delete from public.push_tokens where token = p_token and user_id <> auth.uid();   -- phone changed hands
$$;
revoke execute on function public.save_push_token(text, text, text) from public, anon;
grant execute on function public.save_push_token(text, text, text) to authenticated;

-- Who a manager may wake: active members of the company they can see (themselves included). Only for the push function.
create or replace function public.push_targets(p_org uuid, p_users uuid[] default null)
returns table(user_id uuid, device_id text, token text) language sql stable security definer set search_path = '' as $$
  select t.user_id, t.device_id, t.token from public.push_tokens t
  join public.org_members m on m.user_id = t.user_id and m.org_id = p_org and m.status = 'active'
  where public.is_org_manager(p_org) and public.can_see_user(p_org, t.user_id)
    and (p_users is null or t.user_id = any (p_users))
$$;
revoke execute on function public.push_targets(uuid, uuid[]) from public, anon;
grant execute on function public.push_targets(uuid, uuid[]) to authenticated;

create or replace function public.drop_push_token(p_token text) returns void language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = p_token $$;
revoke execute on function public.drop_push_token(text) from public, anon, authenticated;
