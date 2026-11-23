-- Rule (owner, Nov 24 2026): every table that shows a lead with call details shows WHEN the call was AND how long it was.
-- leads.last_call_sec = length (talk seconds) of the lead's latest call, kept with last_call_at.
alter table public.leads add column if not exists last_call_sec int;

create or replace function public.t_lead_last_call() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  if v_lead is null then return null; end if;
  update public.leads l set last_call_sec = c.duration_sec, last_call_at = greatest(l.last_call_at, c.started_at)
    from (select duration_sec, started_at from public.calls where lead_id = v_lead order by started_at desc limit 1) c
   where l.id = v_lead and (l.last_call_sec is distinct from c.duration_sec or l.last_call_at is distinct from greatest(l.last_call_at, c.started_at));
  return null;
end $$;
drop trigger if exists t_lead_last_call on public.calls;
create trigger t_lead_last_call after insert or update of duration_sec, lead_id on public.calls
  for each row execute function public.t_lead_last_call();

update public.leads l set last_call_sec = c.duration_sec
  from (select distinct on (lead_id) lead_id, duration_sec from public.calls where lead_id is not null order by lead_id, started_at desc) c
 where l.id = c.lead_id;
