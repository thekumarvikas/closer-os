-- Round 16 · C) Calls read from the phone's history after the fact (no outcome expected) vs calls made with Closer OS;
-- the hour of day in the company's time zone so reports can open "calls between 9 and 10 AM".
alter table public.calls add column if not exists from_history boolean generated always as (created_at - started_at > interval '1 hour') stored;
alter table public.calls add column if not exists local_hour smallint;
create or replace function public.t_call_local_hour() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.local_hour := extract(hour from new.started_at at time zone coalesce((select timezone from public.organizations where id = new.org_id), 'Asia/Kolkata'));
  return new;
end $$;
drop trigger if exists t_call_local_hour on public.calls;
create trigger t_call_local_hour before insert or update of started_at on public.calls for each row execute function public.t_call_local_hour();
alter table public.calls disable trigger user;
update public.calls c set local_hour = extract(hour from c.started_at at time zone coalesce(o.timezone, 'Asia/Kolkata')) from public.organizations o where o.id = c.org_id;
alter table public.calls enable trigger user;
create index if not exists calls_org_hour on public.calls (org_id, local_hour, started_at);

-- Outcome report: calls without an outcome that came from the phone's history get their own row
-- (fixed id 00000000-0000-0000-0000-000000000001 = "Before Closer OS / outside the app") instead of "not filled".
do $$ declare d text; begin
  d := pg_get_functiondef('public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[], text[])'::regprocedure);
  d := replace(d, 'select c.user_id, c.lead_id, c.outcome_id, c.duration_sec,',
    'select c.user_id, c.lead_id, coalesce(c.outcome_id, case when c.from_history then ''00000000-0000-0000-0000-000000000001''::uuid end) outcome_id, c.duration_sec,');
  execute d;
end $$;
