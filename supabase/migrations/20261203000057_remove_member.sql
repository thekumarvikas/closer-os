-- Permanently remove a person from a company (not just deactivate).
-- Their leads, reminder calls and pending follow-ups go to someone else (or become unassigned / cancelled);
-- past calls stay in reports, and their name is kept in org_former_members so history still shows it.

create table if not exists public.org_former_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  full_name text, email text,
  removed_at timestamptz not null default now(),
  removed_by uuid,
  primary key (org_id, user_id)
);
alter table public.org_former_members enable row level security;
drop policy if exists former_read on public.org_former_members;
create policy former_read on public.org_former_members for select to authenticated using (public.is_org_member(org_id));

create or replace function public.remove_member(p_org uuid, p_user uuid, p_reassign_to uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role public.member_role; n_leads int; n_rem int; n_fu int; v_name text; v_email text;
begin
  if not public.is_org_admin(p_org) then raise exception 'Only the owner or an admin can remove people'; end if;
  if p_user = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  select role into v_role from public.org_members where org_id = p_org and user_id = p_user;
  if v_role is null then raise exception 'This person is not in the company'; end if;
  if v_role = 'owner' and not (public.org_role(p_org) = 'owner' or public.is_super_admin()) then raise exception 'Only an owner can remove an owner'; end if;
  if v_role = 'owner' and (select count(*) from public.org_members where org_id = p_org and role = 'owner') <= 1 then
    raise exception 'The company must keep at least one owner'; end if;
  if p_reassign_to is not null and not exists (select 1 from public.org_members where org_id = p_org and user_id = p_reassign_to and status = 'active' and user_id <> p_user) then
    raise exception 'Choose an active team member to receive the leads'; end if;

  update public.leads set assigned_to = p_reassign_to, assigned_at = case when p_reassign_to is null then assigned_at else now() end
    where org_id = p_org and assigned_to = p_user;
  get diagnostics n_leads = row_count;
  update public.batch_leads set reminder_by = p_reassign_to where org_id = p_org and reminder_by = p_user;
  get diagnostics n_rem = row_count;
  if p_reassign_to is not null then
    update public.follow_ups set assigned_to = p_reassign_to where org_id = p_org and assigned_to = p_user and status = 'pending';
  else
    update public.follow_ups set status = 'cancelled', notes = coalesce(notes || ' · ', '') || 'Closed: the person was removed from the company'
      where org_id = p_org and assigned_to = p_user and status = 'pending';
  end if;
  get diagnostics n_fu = row_count;

  delete from public.team_members where org_id = p_org and user_id = p_user;
  delete from public.rep_targets where org_id = p_org and user_id = p_user;
  delete from public.announcement_acks a using public.announcements an where an.id = a.announcement_id and an.org_id = p_org and a.user_id = p_user;
  delete from public.message_templates where org_id = p_org and owner_id = p_user;
  delete from public.call_requests where user_id = p_user and lead_id in (select id from public.leads where org_id = p_org);
  delete from public.device_status where org_id = p_org and user_id = p_user;

  select full_name, email into v_name, v_email from public.profiles where id = p_user;
  insert into public.org_former_members (org_id, user_id, full_name, email, removed_by)
  values (p_org, p_user, v_name, v_email, auth.uid())
  on conflict (org_id, user_id) do update set full_name = excluded.full_name, email = excluded.email, removed_at = now(), removed_by = excluded.removed_by;
  delete from public.org_members where org_id = p_org and user_id = p_user;

  perform public.write_audit(p_org, 'member.removed', 'user', p_user::text,
    jsonb_build_object('name', v_name, 'email', v_email, 'reassigned_to', p_reassign_to, 'leads', n_leads, 'reminders', n_rem, 'follow_ups', n_fu));
  return jsonb_build_object('leads', n_leads, 'reminders', n_rem, 'follow_ups', n_fu);
end $$;
revoke execute on function public.remove_member(uuid, uuid, uuid) from anon, public;
grant execute on function public.remove_member(uuid, uuid, uuid) to authenticated;
