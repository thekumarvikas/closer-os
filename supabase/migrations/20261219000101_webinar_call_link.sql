-- Round 16 · B) Every call to a lead registered for a webinar belongs to that webinar, however it was made (app, phone's
-- dialer, laptop, calls from before Closer OS was installed). Owner (Nov 19): reminder = from sign-up (or at most 7 days
-- before) until the webinar STARTS; after the start the call is a sales call for that webinar (until 30 days, or the lead's
-- next webinar). Changing a webinar's time re-plans everything tied to it (calls, WhatsApp sequence messages, reminder
-- call-backs) — no notification to reps.

alter table public.calls add column if not exists batch_auto boolean not null default false;   -- linked by these rules (re-linked when times change)

-- Which webinar a call to this lead at this moment belongs to.
create or replace function public.call_webinar(p_lead uuid, p_at timestamptz, out batch_id uuid, out purpose text)
language sql stable security definer set search_path = '' as $$
  select x.batch_id, x.purpose from (
    -- before the start: reminder call for the NEXT webinar the lead is registered for
    (select b.id batch_id, 'reminder' purpose, 0 pri, b.webinar_at - p_at dist
     from public.batch_leads bl join public.batches b on b.id = bl.batch_id
     where bl.lead_id = p_lead and not coalesce(bl.is_holdout, false) and not b.is_archived
       and p_at < b.webinar_at and p_at >= least(bl.added_at, b.webinar_at - interval '7 days')
     order by b.webinar_at limit 1)
    union all
    -- after the start: sales call for the latest webinar (30 days)
    (select b.id, 'sales', 1, p_at - b.webinar_at
     from public.batch_leads bl join public.batches b on b.id = bl.batch_id
     where bl.lead_id = p_lead and not b.is_archived and p_at >= b.webinar_at and p_at < b.webinar_at + interval '30 days'
     order by b.webinar_at desc limit 1)
  ) x order by x.pri limit 1
$$;
revoke execute on function public.call_webinar(uuid, timestamptz) from public, anon, authenticated;

-- New / relinked calls without a webinar get one by the rules above.
create or replace function public.t_call_webinar() returns trigger language plpgsql security definer set search_path = '' as $$
declare w record;
begin
  if new.lead_id is null then return new; end if;
  if new.batch_id is not null and not new.batch_auto then return new; end if;     -- the app said which webinar
  if tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id and new.started_at is not distinct from old.started_at then return new; end if;
  select * into w from public.call_webinar(new.lead_id, new.started_at);
  if w.batch_id is not null then
    new.batch_id := w.batch_id; new.purpose := w.purpose; new.batch_auto := true;
  elsif new.batch_auto then
    new.batch_id := null; new.purpose := 'sales'; new.batch_auto := false;
  end if;
  return new;
end $$;
drop trigger if exists t_call_webinar on public.calls;
create trigger t_call_webinar before insert or update of lead_id, started_at on public.calls
  for each row execute function public.t_call_webinar();

-- Re-link the calls of one webinar's leads (after its time changes or a lead joins it).
create or replace function public.relink_calls(p_batch uuid, p_lead uuid default null) returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with c as (
    select c.id, w.batch_id, w.purpose from public.calls c
    join public.batch_leads bl on bl.lead_id = c.lead_id and bl.batch_id = p_batch
    cross join lateral public.call_webinar(c.lead_id, c.started_at) w
    where (p_lead is null or c.lead_id = p_lead) and (c.batch_id is null or c.batch_auto)
      and c.started_at > (select webinar_at - interval '60 days' from public.batches where id = p_batch)
  )
  update public.calls x set batch_id = c.batch_id, purpose = coalesce(c.purpose, 'sales'), batch_auto = c.batch_id is not null
  from c where x.id = c.id and (x.batch_id is distinct from c.batch_id or x.purpose is distinct from coalesce(c.purpose, 'sales'));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.relink_calls(uuid, uuid) from public, anon, authenticated;

create or replace function public.t_bl_relink() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.calls where lead_id = new.lead_id) then perform public.relink_calls(new.batch_id, new.lead_id); end if;
  return new;
end $$;
drop trigger if exists t_bl_relink on public.batch_leads;
create trigger t_bl_relink after insert on public.batch_leads for each row execute function public.t_bl_relink();

-- A webinar's time changed: calls, WhatsApp sequence messages "N min before", reminder call-backs all follow.
create or replace function public.t_batch_time() returns trigger language plpgsql security definer set search_path = '' as $$
declare e record;
begin
  if new.webinar_at is not distinct from old.webinar_at then return new; end if;
  perform public.relink_calls(new.id);
  for e in select id, next_pos from public.wa_sequence_leads where batch_id = new.id and status in ('active', 'paused') and next_pos is not null loop
    perform public.seq_advance(e.id, e.next_pos);
  end loop;
  -- Reminder call-backs planned after the new start move to 30 minutes before it (if that is still ahead).
  update public.follow_ups f set due_at = greatest(new.webinar_at - interval '30 minutes', now() + interval '5 minutes')
  where f.status = 'pending' and f.purpose = 'reminder' and f.due_at > new.webinar_at
    and f.lead_id in (select lead_id from public.batch_leads where batch_id = new.id)
    and new.webinar_at > now();
  return new;
end $$;
drop trigger if exists t_batch_time on public.batches;
create trigger t_batch_time after update of webinar_at on public.batches for each row execute function public.t_batch_time();

-- Link all existing calls.
alter table public.calls disable trigger user;
with c as (
  select c.id, w.batch_id, w.purpose from public.calls c
  cross join lateral public.call_webinar(c.lead_id, c.started_at) w
  where c.lead_id is not null and c.batch_id is null and w.batch_id is not null
)
update public.calls x set batch_id = c.batch_id, purpose = c.purpose, batch_auto = true from c where x.id = c.id;
alter table public.calls enable trigger user;

-- Calls of a DELETED lead move to the live lead with the same number (a list deleted and imported again kept its calls
-- on the old copies — Cancer Consultation Circle, Nov 18). Also for every lead added from now on.
create or replace function public.adopt_calls_of_deleted(p_lead uuid) returns int language plpgsql security definer set search_path = '' as $$
declare l record; n int := 0;
begin
  select id, org_id, phone_key into l from public.leads where id = p_lead and deleted_at is null;
  if l.id is null or coalesce(l.phone_key, '') = '' then return 0; end if;
  update public.calls c set lead_id = l.id
  where c.org_id = l.org_id and c.lead_id in (select d.id from public.leads d where d.org_id = l.org_id and d.phone_key = l.phone_key
                                               and d.deleted_at is not null and d.merged_into is null and d.id <> l.id);
  get diagnostics n = row_count;
  if n > 0 then perform public.refresh_lead_stats(l.id); end if;
  return n;
end $$;
revoke execute on function public.adopt_calls_of_deleted(uuid) from public, anon, authenticated;

create or replace function public.t_lead_adopt_calls() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.phone_key, '') <> '' and exists (select 1 from public.leads d where d.org_id = new.org_id and d.phone_key = new.phone_key
       and d.deleted_at is not null and d.merged_into is null and d.id <> new.id) then
    perform public.adopt_calls_of_deleted(new.id);
  end if;
  return null;
end $$;
drop trigger if exists t_lead_adopt_calls on public.leads;
create trigger t_lead_adopt_calls after insert on public.leads for each row execute function public.t_lead_adopt_calls();

select public.adopt_calls_of_deleted(l.id) from public.leads l
where l.deleted_at is null and exists (select 1 from public.leads d join public.calls c on c.lead_id = d.id
  where d.org_id = l.org_id and d.phone_key = l.phone_key and d.deleted_at is not null and d.merged_into is null and d.id <> l.id);
