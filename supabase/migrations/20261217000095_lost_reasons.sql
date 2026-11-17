-- Round 15 · 7) Why leads were lost. Owner: "we track the positive closings — we should get insight from lost sales too."
-- When a rep saves a lost-category outcome they can tap a reason; it travels in calls.outcome_data.lost_reason (a key).
-- Default reasons (companies edit organizations.settings.lost_reasons = [{key, label}]; same defaults in the app
-- data/LostReasons.kt and web lib/lostReasons.ts): price · timing · noneed · decider · noshow · competitor · trust · other.
-- The lead keeps its latest reason (leads.lost_reason / lost_at); a later sale clears it.

alter table public.leads add column if not exists lost_reason text;
alter table public.leads add column if not exists lost_at timestamptz;

create or replace function public.t_call_lost_reason() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cat text;
begin
  if new.lead_id is null or new.outcome_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.outcome_id is not distinct from old.outcome_id and new.outcome_data is not distinct from old.outcome_data then return new; end if;
  select category into v_cat from public.call_outcomes where id = new.outcome_id;
  if v_cat = 'lost' then
    update public.leads set lost_reason = coalesce(nullif(new.outcome_data->>'lost_reason', ''), lost_reason),
      lost_at = coalesce(new.ended_at, new.started_at, now()), updated_at = now()
    where id = new.lead_id and (lost_reason is distinct from coalesce(nullif(new.outcome_data->>'lost_reason', ''), lost_reason) or lost_at is null
      or lost_at < coalesce(new.ended_at, new.started_at, now()));
  elsif v_cat = 'won' then
    update public.leads set lost_reason = null, lost_at = null, updated_at = now() where id = new.lead_id and (lost_reason is not null or lost_at is not null);
  end if;
  return new;
end $$;
drop trigger if exists t_call_lost_reason on public.calls;
create trigger t_call_lost_reason after insert or update of outcome_id, outcome_data on public.calls
  for each row execute function public.t_call_lost_reason();

-- Each lead lost in the period, counted once with its latest lost call's reason ('none' = no reason given).
create or replace function public.lost_facts(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null)
returns table(lead_id uuid, user_id uuid, reason text, lost_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select distinct on (c.lead_id) c.lead_id, c.user_id, coalesce(nullif(c.outcome_data->>'lost_reason', ''), 'none'), c.started_at
  from public.calls c join public.call_outcomes o on o.id = c.outcome_id and o.category = 'lost'
  where c.org_id = p_org and c.lead_id is not null and c.started_at >= p_from and c.started_at < p_to
    and public.is_org_member(p_org)
    and c.user_id = any(coalesce(p_users, public.visible_user_ids(p_org)))
    and c.user_id = any(public.visible_user_ids(p_org))
  order by c.lead_id, c.started_at desc
$$;
revoke execute on function public.lost_facts(uuid, timestamptz, timestamptz, uuid[]) from anon, public, authenticated;

create or replace function public.lost_report(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with f as (select * from public.lost_facts(p_org, p_from, p_to, p_users))
  select jsonb_build_object(
    'leads', (select count(*) from f),
    'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'leads', n) order by n desc)
                         from (select reason, count(*) n from f group by reason) x), '[]'::jsonb),
    'by_user', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'reason', reason, 'leads', n))
                         from (select user_id, reason, count(*) n from f group by user_id, reason) y), '[]'::jsonb)
  )
$$;
grant execute on function public.lost_report(uuid, timestamptz, timestamptz, uuid[]) to authenticated;

-- The leads behind one reason (and optionally one team member).
create or replace function public.lost_report_leads(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[], p_reason text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select lead_id from public.lost_facts(p_org, p_from, p_to, p_users) where p_reason is null or reason = p_reason order by lost_at desc
$$;
grant execute on function public.lost_report_leads(uuid, timestamptz, timestamptz, uuid[], text) to authenticated;
