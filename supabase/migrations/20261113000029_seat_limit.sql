-- Paid companies can't have more active people than the users they paid for (trials: no limit).
create or replace function public.check_seat_limit() returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; v_used int;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return new; end if;
  select * into s from public.subscriptions where org_id = new.org_id;
  if s.status <> 'active' or s.current_period_end < now() then return new; end if;
  select count(*) into v_used from public.org_members where org_id = new.org_id and status = 'active' and user_id <> new.user_id;
  if v_used >= s.seats then
    raise exception 'All % paid users are in use. Add more users on Plan & billing, or deactivate someone first.', s.seats;
  end if;
  return new;
end $$;
drop trigger if exists t_seat_limit on public.org_members;
create trigger t_seat_limit before insert or update of status on public.org_members for each row execute function public.check_seat_limit();
