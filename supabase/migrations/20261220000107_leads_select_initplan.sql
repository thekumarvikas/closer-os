-- leads_select, take 2: the per-row security functions (is_org_member, can_see_lead, can_see_user… each a separate
-- lookup) cost ~0.7 ms a row → 2–3.5 s for a rep in a 3,000-lead company and timeouts with webinars embedded. Same
-- rule, but "who am I / whom can I see" is worked out ONCE per query (InitPlan) and each row only compares arrays.
create or replace function public.my_member_orgs() returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(org_id), '{}') from public.org_members where user_id = auth.uid() and status = 'active' $$;
create or replace function public.my_admin_orgs() returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(org_id), '{}') from public.org_members where user_id = auth.uid() and status = 'active' and role in ('owner', 'admin') $$;
create or replace function public.my_manager_orgs() returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(org_id), '{}') from public.org_members where user_id = auth.uid() and status = 'active' and role = 'manager' $$;
-- Me + everyone in the teams I manage (in companies where I'm a manager) = can_see_user for non-admins.
create or replace function public.my_seen_users() returns uuid[] language sql stable security definer set search_path = '' as $$
  select array_agg(distinct u) from (
    select auth.uid() u
    union all
    select theirs.user_id from public.team_members mine
    join public.team_members theirs on theirs.team_id = mine.team_id
    join public.org_members om on om.org_id = mine.org_id and om.user_id = auth.uid() and om.status = 'active' and om.role = 'manager'
    where mine.user_id = auth.uid() and mine.is_manager
  ) x where u is not null $$;
create or replace function public.lead_reminder_in(p_lead uuid, p_users uuid[]) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.batch_leads where lead_id = p_lead and reminder_by = any (p_users)) $$;
revoke execute on function public.my_member_orgs(), public.my_admin_orgs(), public.my_manager_orgs(), public.my_seen_users(), public.lead_reminder_in(uuid, uuid[]) from public, anon;
grant execute on function public.my_member_orgs(), public.my_admin_orgs(), public.my_manager_orgs(), public.my_seen_users(), public.lead_reminder_in(uuid, uuid[]) to authenticated;

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select using (
  (select public.is_super_admin())
  or (org_id = any ((select public.my_member_orgs())::uuid[]) and (
        org_id = any ((select public.my_admin_orgs())::uuid[])
        or (assigned_to is null and org_id = any ((select public.my_manager_orgs())::uuid[]))
        or assigned_to = any ((select public.my_seen_users())::uuid[])
        or shared_with && (select public.my_seen_users())
        or public.lead_reminder_in(id, (select public.my_seen_users()))
  ))
);
