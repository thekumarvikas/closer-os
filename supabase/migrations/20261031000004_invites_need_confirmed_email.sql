-- Invitations are matched by email, so only accept them once the email address is confirmed
-- (Google sign-in emails are confirmed automatically).
create or replace function public.accept_my_invitations()
returns int language plpgsql security definer set search_path = '' as $$
declare v_email text; inv record; n int := 0; t uuid;
begin
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  for inv in
    select * from public.invitations
    where lower(email) = v_email and accepted_at is null and expires_at > now()
    for update
  loop
    insert into public.org_members (org_id, user_id, role)
    values (inv.org_id, auth.uid(), inv.role)
    on conflict (org_id, user_id) do update set status = 'active', role = excluded.role;
    foreach t in array inv.team_ids loop
      insert into public.team_members (team_id, user_id, org_id, is_manager)
      select t, auth.uid(), inv.org_id, inv.role = 'manager'
      where exists (select 1 from public.teams where id = t and org_id = inv.org_id)
      on conflict do nothing;
    end loop;
    update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
    insert into public.audit_logs (org_id, actor_id, action, entity, entity_id)
    values (inv.org_id, auth.uid(), 'invitation.accepted', 'invitation', inv.id::text);
    n := n + 1;
  end loop;
  return n;
end $$;
