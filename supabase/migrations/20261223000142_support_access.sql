-- Closer OS support access (owner, Nov 23 2026).
-- Before: the Super Admin login silently counted as an admin of EVERY company. Now Closer OS staff can open a
-- company only through a recorded visit ("support session"), only while the company allows it
-- (settings.support_access, on by default), view-only or with changes. The company sees every visit.

create table if not exists public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'view' check (mode in ('view', 'edit')),
  reason text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '8 hours',
  ended_at timestamptz
);
create index if not exists support_sessions_user on public.support_sessions (user_id, ended_at, expires_at);
create index if not exists support_sessions_org on public.support_sessions (org_id, started_at desc);
alter table public.support_sessions enable row level security;
-- read only through RPCs
revoke all on public.support_sessions from anon, authenticated;

create or replace function public.support_allowed(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select (settings->>'support_access')::boolean from public.organizations where id = p_org), true)
$$;

-- The current user's open support visit for this company: 'view' | 'edit' | null.
create or replace function public.support_mode(p_org uuid) returns text
language sql stable security definer set search_path to '' as $$
  select s.mode from public.support_sessions s
  join public.profiles p on p.id = s.user_id and p.is_super_admin
  where s.user_id = auth.uid() and s.org_id = p_org and s.ended_at is null and s.expires_at > now()
    and public.support_allowed(p_org)
  order by s.started_at desc limit 1
$$;

create or replace function public.my_support_orgs() returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(distinct s.org_id), '{}') from public.support_sessions s
  join public.profiles p on p.id = s.user_id and p.is_super_admin
  where s.user_id = auth.uid() and s.ended_at is null and s.expires_at > now() and public.support_allowed(s.org_id)
$$;

-- Membership checks: real members, or an open support visit (no more silent Super Admin access).
create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.org_role(p_org) is not null or public.support_mode(p_org) is not null
$$;
create or replace function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.org_role(p_org) in ('owner', 'admin') or public.support_mode(p_org) is not null
$$;
create or replace function public.my_member_orgs() returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(org_id), '{}') || public.my_support_orgs() from public.org_members where user_id = auth.uid() and status = 'active'
$$;
create or replace function public.my_admin_orgs() returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(org_id), '{}') || public.my_support_orgs() from public.org_members
  where user_id = auth.uid() and status = 'active' and role in ('owner', 'admin')
$$;

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select using (
  (org_id = any ((select public.my_member_orgs())::uuid[])) and (
    (org_id = any ((select public.my_admin_orgs())::uuid[]))
    or (assigned_to is null and org_id = any ((select public.my_manager_orgs())::uuid[]))
    or (assigned_to = any ((select public.my_seen_users())::uuid[]))
    or (shared_with && (select public.my_seen_users()))
    or public.lead_reminder_in(id, (select public.my_seen_users()))));

-- Super Admin: open / close a visit.
create or replace function public.sa_support_open(p_org uuid, p_mode text default 'view', p_reason text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id uuid; v_name text;
begin
  if not public.is_super_admin() then raise exception 'Only Closer OS staff can do this'; end if;
  select name into v_name from public.organizations where id = p_org;
  if v_name is null then raise exception 'Company not found'; end if;
  if not public.support_allowed(p_org) then
    raise exception '% has turned off support access. Ask them to turn it on in Settings → Company.', v_name;
  end if;
  update public.support_sessions set ended_at = now() where user_id = auth.uid() and ended_at is null;
  insert into public.support_sessions (org_id, user_id, mode, reason)
  values (p_org, auth.uid(), case when p_mode = 'edit' then 'edit' else 'view' end, nullif(trim(p_reason), ''))
  returning id into v_id;
  perform public.write_audit(p_org, 'support.opened', 'support_session', v_id::text,
    jsonb_build_object('mode', case when p_mode = 'edit' then 'edit' else 'view' end, 'reason', nullif(trim(p_reason), '')));
  return jsonb_build_object('id', v_id, 'org_id', p_org, 'name', v_name, 'mode', case when p_mode = 'edit' then 'edit' else 'view' end);
end $$;

create or replace function public.sa_support_close() returns void
language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  for s in update public.support_sessions set ended_at = now()
           where user_id = auth.uid() and ended_at is null returning id, org_id loop
    perform public.write_audit(s.org_id, 'support.closed', 'support_session', s.id::text, '{}'::jsonb);
  end loop;
end $$;

-- My open visit (for the dashboard banner after a page reload).
create or replace function public.sa_support_current() returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('id', s.id, 'org_id', s.org_id, 'name', o.name, 'mode', s.mode, 'expires_at', s.expires_at)
  from public.support_sessions s join public.organizations o on o.id = s.org_id
  where s.user_id = auth.uid() and s.ended_at is null and s.expires_at > now() and public.support_allowed(s.org_id)
  order by s.started_at desc limit 1
$$;

-- The company's own view: switch + every visit and what was changed during it.
create or replace function public.set_support_access(p_org uuid, p_on boolean) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if public.org_role(p_org) not in ('owner', 'admin') then raise exception 'Only the owner or an admin can change this'; end if;
  update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('support_access', p_on) where id = p_org;
  if not p_on then
    update public.support_sessions set ended_at = now() where org_id = p_org and ended_at is null;
  end if;
  perform public.write_audit(p_org, case when p_on then 'support.allowed' else 'support.turned_off' end, 'organization', p_org::text, '{}'::jsonb);
end $$;

create or replace function public.support_visits(p_org uuid, p_limit int default 50) returns jsonb
language sql stable security definer set search_path to '' as $$
  select case when public.org_role(p_org) in ('owner', 'admin') or public.is_super_admin() then coalesce((
    select jsonb_agg(v order by v->>'started_at' desc) from (
      select jsonb_build_object('id', s.id, 'by', coalesce(p.full_name, 'Closer OS support'), 'mode', s.mode, 'reason', s.reason,
        'started_at', s.started_at, 'ended_at', coalesce(s.ended_at, least(s.expires_at, now())), 'open', s.ended_at is null and s.expires_at > now(),
        'changes', (select coalesce(jsonb_agg(jsonb_build_object('action', a.action, 'at', a.created_at) order by a.created_at), '[]'::jsonb)
                    from public.audit_logs a where a.org_id = s.org_id and a.actor_id = s.user_id
                      and a.created_at between s.started_at and coalesce(s.ended_at, s.expires_at)
                      and a.action not like 'support.%')) v
      from public.support_sessions s left join public.profiles p on p.id = s.user_id
      where s.org_id = p_org order by s.started_at desc limit p_limit) x), '[]'::jsonb)
  else '[]'::jsonb end
$$;

grant execute on function public.sa_support_open(uuid, text, text), public.sa_support_close(), public.sa_support_current(),
  public.set_support_access(uuid, boolean), public.support_visits(uuid, int), public.support_mode(uuid) to authenticated;
