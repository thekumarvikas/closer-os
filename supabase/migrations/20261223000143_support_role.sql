-- During a support visit the visitor's role in that company is 'admin', so every check (RPCs that read org_role directly,
-- e.g. search_leads, dashboards) agrees with is_org_admin. Real members always keep their own role.
create or replace function public.org_role(p_org uuid) returns public.member_role
language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select role from public.org_members where org_id = p_org and user_id = auth.uid() and status = 'active'),
    case when public.support_mode(p_org) is not null then 'admin'::public.member_role end)
$$;
-- is_org_admin / is_org_member already include visits; keep them simple and consistent.
create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$ select public.org_role(p_org) is not null $$;
create or replace function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path to '' as $$ select public.org_role(p_org) in ('owner', 'admin') $$;
