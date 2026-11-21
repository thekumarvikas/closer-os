-- Owner (Nov 21 2026): keep the sheet's registrations as the original. Deleting a webinar that came from a sheet parks its
-- registrations; when the sheet creates that webinar again (same source + same day), they are added back automatically.
create table if not exists public.batch_parked_regs (
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null, webinar_day date not null, lead_id uuid not null references public.leads(id) on delete cascade,
  reminder_by uuid, parked_at timestamptz not null default now(),
  primary key (source_id, webinar_day, lead_id));
alter table public.batch_parked_regs enable row level security;

create or replace function public.delete_batch(p_batch uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.batches; v_tz text;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null or not public.is_org_manager(b.org_id) then raise exception 'Only managers can delete webinars'; end if;
  if b.source_id is not null then
    select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = b.org_id;
    insert into public.batch_parked_regs (org_id, source_id, webinar_day, lead_id, reminder_by)
    select b.org_id, b.source_id, (b.webinar_at at time zone v_tz)::date, bl.lead_id, bl.reminder_by
    from public.batch_leads bl where bl.batch_id = p_batch and coalesce(bl.registered, true)
    on conflict do nothing;
  end if;
  delete from public.batches where id = p_batch;
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
  values (b.org_id, auth.uid(), 'batch.deleted', 'batch', p_batch, jsonb_build_object('name', b.name, 'webinar_at', b.webinar_at));
end $$;

create or replace function public.t_batch_unpark() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_day date;
begin
  if new.source_id is null then return null; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = new.org_id;
  v_day := (new.webinar_at at time zone v_tz)::date;
  insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, reminder_by)
  select new.id, p.lead_id, new.org_id, false, coalesce(l.assigned_to, p.reminder_by)
  from public.batch_parked_regs p join public.leads l on l.id = p.lead_id and l.deleted_at is null
  where p.source_id = new.source_id and p.webinar_day = v_day
  on conflict do nothing;
  delete from public.batch_parked_regs where source_id = new.source_id and webinar_day = v_day;
  return null;
end $$;
drop trigger if exists t_batch_unpark on public.batches;
create trigger t_batch_unpark after insert on public.batches for each row execute function public.t_batch_unpark();

-- How many people registered from a sheet (shown in the delete confirmation).
create or replace function public.batch_sheet_regs(p_batch uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.batch_leads bl join public.batches b on b.id = bl.batch_id
  where bl.batch_id = p_batch and coalesce(bl.registered, true) and public.is_org_manager(b.org_id)
$$;
grant execute on function public.batch_sheet_regs(uuid) to authenticated;

-- Repair (Cancer, 23 Nov): rows the sheet sent for 23/11/2026 whose people are not in the current 23 Nov webinar
-- (the first 23 Nov webinar was deleted on 20 Nov after a wrong Zoom upload).
insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, reminder_by)
select distinct on (l.id) '2b1975ef-cfc5-4c52-aaf1-fbd25fe172c2'::uuid, l.id, l.org_id, false, l.assigned_to
from public.lead_source_events e join public.leads l on l.id = e.lead_id and l.deleted_at is null
where e.source_id = '3c2b4a22-a07c-41fe-b6d5-571f52642092' and e.payload->>'Webinar Date' = '23/11/2026'
  and e.status in ('created', 'joined', 'duplicate', 'already')
on conflict do nothing;
