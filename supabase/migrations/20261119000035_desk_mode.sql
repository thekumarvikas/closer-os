-- Desk mode: reps work from the laptop too. The laptop asks the rep's phone to dial (call_requests);
-- the phone reports when the call ended; the outcome can then be saved on either screen.
create table if not exists public.call_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  purpose text not null default 'sales' check (purpose in ('sales', 'reminder')),
  batch_id uuid references public.batches(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'dialing', 'ended', 'logged', 'cancelled')),
  call_id uuid,                 -- the call-log id the phone used (same id as the calls row)
  started_at timestamptz, duration_sec int, phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists call_requests_user on public.call_requests (user_id, created_at desc);
alter table public.call_requests enable row level security;
drop policy if exists call_requests_own on public.call_requests;
create policy call_requests_own on public.call_requests for select using (user_id = auth.uid());

-- Laptop: "call this lead on my phone".
create or replace function public.request_call(p_lead uuid, p_purpose text default 'sales', p_batch uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select org_id into v_org from public.leads where id = p_lead and deleted_at is null;
  if exists (select 1 from public.leads where id = p_lead and do_not_call) then raise exception 'This lead is marked Do Not Call'; end if;
  update public.call_requests set status = 'cancelled', updated_at = now() where user_id = auth.uid() and status = 'pending';
  insert into public.call_requests (org_id, user_id, lead_id, purpose, batch_id) values (v_org, auth.uid(), p_lead, coalesce(p_purpose, 'sales'), p_batch)
  returning id into v_id;
  return v_id;
end $$;

-- Phone: the newest request waiting for me (last 2 minutes), claimed so it dials only once.
create or replace function public.claim_call_request()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.call_requests;
begin
  update public.call_requests set status = 'cancelled', updated_at = now()
  where user_id = auth.uid() and status = 'pending' and created_at < now() - interval '2 minutes';
  update public.call_requests set status = 'dialing', updated_at = now()
  where id = (select id from public.call_requests where user_id = auth.uid() and status = 'pending' order by created_at desc limit 1)
  returning * into r;
  if r.id is null then return null; end if;
  return jsonb_build_object('id', r.id, 'lead_id', r.lead_id, 'purpose', r.purpose, 'batch_id', r.batch_id);
end $$;

-- Phone: the call is over (details for the outcome form on the laptop).
create or replace function public.call_request_ended(p_id uuid, p_call uuid, p_started timestamptz, p_duration int, p_phone text)
returns void language sql security definer set search_path = '' as $$
  update public.call_requests set status = 'ended', call_id = p_call, started_at = p_started, duration_sec = p_duration, phone = p_phone, updated_at = now()
  where id = p_id and user_id = auth.uid() and status in ('pending', 'dialing')
$$;

create or replace function public.cancel_call_request(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.call_requests set status = 'cancelled', updated_at = now() where id = p_id and user_id = auth.uid() and status in ('pending', 'dialing')
$$;

-- When an outcome is saved (from either screen) the request is done.
create or replace function public.call_request_logged() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.outcome_id is not null and (tg_op = 'INSERT' or old.outcome_id is null) then
    update public.call_requests set status = 'logged', updated_at = now() where call_id = new.id and status <> 'logged';
  end if;
  return new;
end $$;
drop trigger if exists t_call_request_logged on public.calls;
create trigger t_call_request_logged after insert or update of outcome_id on public.calls for each row execute function public.call_request_logged();

-- Which of these calls already have an outcome (so the phone doesn't ask again).
create or replace function public.calls_with_outcome(p_ids uuid[])
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(id), '{}') from public.calls where id = any(p_ids) and user_id = auth.uid() and outcome_id is not null
$$;

-- Laptop: my lead calls of the last 24 hours that still need an outcome.
create or replace function public.my_calls_needing_outcome(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'lead_id', c.lead_id, 'lead_name', l.name, 'phone', c.phone, 'direction', c.direction,
    'started_at', c.started_at, 'duration_sec', c.duration_sec, 'purpose', c.purpose, 'batch_id', c.batch_id, 'sim_slot', c.sim_slot) order by c.started_at desc), '[]')
  from public.calls c join public.leads l on l.id = c.lead_id
  where c.org_id = p_org and c.user_id = auth.uid() and c.outcome_id is null and c.started_at > now() - interval '24 hours'
    and (c.direction = 'outgoing' or (c.direction = 'incoming' and c.duration_sec > 0))
$$;

do $$ declare f text; begin
  foreach f in array array['request_call(uuid, text, uuid)', 'claim_call_request()', 'call_request_ended(uuid, uuid, timestamptz, int, text)',
    'cancel_call_request(uuid)', 'calls_with_outcome(uuid[])', 'my_calls_needing_outcome(uuid)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
