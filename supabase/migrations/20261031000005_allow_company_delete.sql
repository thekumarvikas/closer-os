-- Deleting a whole company removes its members too; the "keep one owner" rule must not block that.
create or replace function public.guard_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid := coalesce(new.org_id, old.org_id);
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = v_org) then
    return old;
  end if;
  if auth.uid() is not null and not public.is_super_admin() then
    if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
      if public.org_role(v_org) is distinct from 'owner'
         and not (tg_op = 'INSERT' and new.user_id = auth.uid()
                  and not exists (select 1 from public.org_members where org_id = v_org)
                  and exists (select 1 from public.organizations where id = v_org and created_by = auth.uid())) then
        raise exception 'Only an owner can add, change or remove owners';
      end if;
    end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' and old.status = 'active' then
    if (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active') and not exists (
      select 1 from public.org_members
      where org_id = v_org and role = 'owner' and status = 'active' and user_id <> old.user_id
    ) then
      raise exception 'A company must keep at least one active owner';
    end if;
  end if;
  return coalesce(new, old);
end $$;
