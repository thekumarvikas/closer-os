-- Per-SIM subscriptions (company app, Nov 2026). A subscription = one tracked SIM.
-- Each rep chooses the ONE SIM they use for work; only that SIM's calls are tracked (app + dashboard). The other SIM's
-- calls never reach Closer OS. Tracking a second SIM = one more subscription (manager approves). Changing the work SIM
-- = rep requests, manager approves. WhatsApp calls count under the rep's subscription. Dashboard-only managers are free.
-- The individual app (Pro) is unchanged: one subscription covers both SIMs.

create table if not exists public.member_sims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  sim_number text not null,
  slot int,
  label text,
  kind text not null default 'first',                 -- first | add (second SIM) | replace (change of work SIM)
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'removed')),
  note text,
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz
);
create index if not exists member_sims_org on public.member_sims (org_id, status);
create unique index if not exists member_sims_one_live on public.member_sims (org_id, user_id, public.phone_key(sim_number)) where status in ('pending', 'active');
alter table public.member_sims enable row level security;
drop policy if exists member_sims_select on public.member_sims;
create policy member_sims_select on public.member_sims for select using (user_id = auth.uid() or public.is_org_manager(org_id));

-- Subscriptions in use = tracked SIMs (company accounts). Managers who only use the dashboard don't need one.
create or replace function public.sims_used(p_org uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.member_sims s join public.org_members m on m.org_id = s.org_id and m.user_id = s.user_id and m.status = 'active'
  where s.org_id = p_org and s.status = 'active'
$$;

-- Room for one more tracked SIM? (only paid, running subscriptions have a limit; trials and free accounts don't)
create or replace function public.sim_seat_free(p_org uuid) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  select * into s from public.subscriptions where org_id = p_org;
  if s.org_id is null or s.status <> 'active' or s.current_period_end < now() then return true; end if;
  return public.sims_used(p_org) < s.seats;
end $$;

-- Members no longer use up a paid seat (the SIM does).
create or replace function public.check_seat_limit() returns trigger language plpgsql security definer set search_path = '' as $$
begin return new; end $$;

-- The rep picks their work SIM (first time: tracked at once if there's room), or asks to change it / add a second SIM.
create or replace function public.request_work_sim(p_org uuid, p_number text, p_slot int default null, p_label text default null, p_kind text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_num text; v_kind text; v_has boolean; v_id uuid; v_status text;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if (select is_individual from public.organizations where id = p_org) then raise exception 'Not needed in the individual app'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  v_num := public.normalize_phone(p_number, v_prefix);
  if v_num is null or length(regexp_replace(v_num, '\D', '', 'g')) < 8 then raise exception 'Enter the SIM''s phone number'; end if;
  if exists (select 1 from public.member_sims where org_id = p_org and user_id = auth.uid() and status in ('pending', 'active') and public.phone_key(sim_number) = public.phone_key(v_num)) then
    return (select jsonb_build_object('id', id, 'status', status) from public.member_sims where org_id = p_org and user_id = auth.uid() and status in ('pending', 'active') and public.phone_key(sim_number) = public.phone_key(v_num) limit 1);
  end if;
  v_has := exists (select 1 from public.member_sims where org_id = p_org and user_id = auth.uid() and status = 'active');
  v_kind := case when not v_has then 'first' else coalesce(nullif(p_kind, ''), 'replace') end;
  v_status := case when v_kind = 'first' and public.sim_seat_free(p_org) then 'active' else 'pending' end;
  insert into public.member_sims (org_id, user_id, sim_number, slot, label, kind, status, note, decided_at)
  values (p_org, auth.uid(), v_num, p_slot, nullif(trim(p_label), ''), v_kind, v_status, nullif(trim(p_note), ''), case when v_status = 'active' then now() end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', v_status, 'kind', v_kind,
    'message', case when v_status = 'active' then 'Work SIM saved — only this SIM''s calls are tracked'
                    when v_kind = 'first' then 'All paid SIMs are in use — your manager needs to add one on Plan & billing'
                    else 'Sent to your manager to approve' end);
end $$;

-- Manager decision. Approving a second SIM needs a free subscription; approving a change replaces the old work SIM.
create or replace function public.review_work_sim(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.member_sims;
begin
  select * into s from public.member_sims where id = p_id;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can approve SIMs'; end if;
  if s.status <> 'pending' then raise exception 'Already decided'; end if;
  if p_approve then
    if s.kind = 'replace' then
      update public.member_sims set status = 'removed', decided_by = auth.uid(), decided_at = now(), note = 'Replaced by ' || s.sim_number
      where org_id = s.org_id and user_id = s.user_id and status = 'active';
    elsif not public.sim_seat_free(s.org_id) then
      raise exception 'All paid SIMs are in use. Add one more SIM on Plan & billing, then approve.';
    end if;
    update public.member_sims set status = 'active', decided_by = auth.uid(), decided_at = now(), note = coalesce(nullif(trim(p_note), ''), note) where id = p_id;
  else
    update public.member_sims set status = 'rejected', decided_by = auth.uid(), decided_at = now(), note = nullif(trim(p_note), '') where id = p_id;
  end if;
  perform public.write_audit(s.org_id, case when p_approve then 'sim.approved' else 'sim.rejected' end, 'member_sim', s.id::text,
    jsonb_build_object('user', s.user_id, 'number', s.sim_number, 'kind', s.kind));
end $$;

-- Stop tracking a SIM (managers; frees the subscription).
create or replace function public.remove_work_sim(p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.member_sims;
begin
  select * into s from public.member_sims where id = p_id;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can remove SIMs'; end if;
  update public.member_sims set status = 'removed', decided_by = auth.uid(), decided_at = now() where id = p_id;
  perform public.write_audit(s.org_id, 'sim.removed', 'member_sim', s.id::text, jsonb_build_object('user', s.user_id, 'number', s.sim_number));
end $$;

create or replace function public.org_work_sims(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  return jsonb_build_object('used', public.sims_used(p_org),
    'seats', (select case when s.status = 'active' then s.seats end from public.subscriptions s where s.org_id = p_org),
    'sims', coalesce((select jsonb_agg(to_jsonb(m) order by m.status = 'pending' desc, m.requested_at desc) from public.member_sims m
      where m.org_id = p_org and m.status in ('pending', 'active') and (m.user_id = auth.uid() or public.is_org_manager(p_org))), '[]'::jsonb));
end $$;

-- Calls from a SIM that isn't the rep's work SIM never get stored (server-side guard; the app also never sends them).
-- Only applies once the rep has a tracked SIM; WhatsApp calls and calls with an unknown SIM are kept.
create or replace function public.t_calls_work_sim() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.channel = 'phone' and new.sim_number is not null and new.user_id is not null
     and exists (select 1 from public.member_sims s where s.org_id = new.org_id and s.user_id = new.user_id and s.status = 'active')
     and not exists (select 1 from public.member_sims s where s.org_id = new.org_id and s.user_id = new.user_id and s.status = 'active'
                     and public.phone_key(s.sim_number) = public.phone_key(new.sim_number)) then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists t_calls_work_sim on public.calls;
create trigger t_calls_work_sim before insert on public.calls for each row execute function public.t_calls_work_sim();

-- Plan & billing counts tracked SIMs.
create or replace function public.org_access(p_org uuid)
 returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare s public.subscriptions; p public.plans; g int; v_end timestamptz; v_state text; v_used int;
begin
  if not (public.is_org_member(p_org) or public.is_super_admin()) then raise exception 'Not allowed'; end if;
  select * into s from public.subscriptions where org_id = p_org;
  select * into p from public.plans where id = s.plan_id;
  select grace_days into g from public.platform_settings;
  v_used := public.sims_used(p_org);
  v_end := case s.status when 'trialing' then s.trial_ends_at when 'active' then s.current_period_end else null end;
  v_state := case
    when s.org_id is null or s.status = 'complimentary' then 'active'
    when s.status = 'cancelled' then 'expired'
    when v_end > now() then case when s.status = 'trialing' then 'trial' else 'active' end
    when v_end + make_interval(days => g) > now() then 'grace'
    else 'expired' end;
  return jsonb_build_object('state', v_state, 'status', coalesce(s.status, 'complimentary'), 'plan', p.name, 'plan_id', p.id,
    'features', coalesce(p.features, '{}'::jsonb), 'seats', coalesce(s.seats, 9999), 'seats_used', v_used, 'seat_unit', 'sim', 'cycle', s.cycle,
    'ends_at', v_end, 'grace_ends_at', v_end + make_interval(days => g),
    'days_left', case when v_end is null then null else greatest(0, ceil(extract(epoch from (v_end - now())) / 86400))::int end);
end $function$;

revoke execute on function public.t_calls_work_sim() from anon, public, authenticated;
revoke execute on function public.sims_used(uuid) from anon, public;
revoke execute on function public.sim_seat_free(uuid) from anon, public;
revoke execute on function public.request_work_sim(uuid, text, int, text, text, text) from anon, public;
revoke execute on function public.review_work_sim(uuid, boolean, text) from anon, public;
revoke execute on function public.remove_work_sim(uuid) from anon, public;
revoke execute on function public.org_work_sims(uuid) from anon, public;
grant execute on function public.sims_used(uuid) to authenticated;
grant execute on function public.request_work_sim(uuid, text, int, text, text, text) to authenticated;
grant execute on function public.review_work_sim(uuid, boolean, text) to authenticated;
grant execute on function public.remove_work_sim(uuid) to authenticated;
grant execute on function public.org_work_sims(uuid) to authenticated;
