-- Daily targets per rep (calls dialled, conversations, talk minutes, sales). A row with user_id null
-- is the company default; a row for a person overrides it. Working days come from
-- organizations.settings.work_days (ISO weekday numbers, default Mon–Sat).
create table if not exists public.rep_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  calls int check (calls >= 0),
  conversations int check (conversations >= 0),
  talk_minutes int check (talk_minutes >= 0),
  sales int check (sales >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists rep_targets_person on public.rep_targets (org_id, user_id) where user_id is not null;
create unique index if not exists rep_targets_default on public.rep_targets (org_id) where user_id is null;
alter table public.rep_targets enable row level security;
drop policy if exists rep_targets_read on public.rep_targets;
create policy rep_targets_read on public.rep_targets for select using (public.is_org_member(org_id));

-- Managers set targets (p_user null = company default). Empty values clear that target.
create or replace function public.set_rep_target(p_org uuid, p_user uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can set targets'; end if;
  if p_user is not null and not exists (select 1 from public.org_members where org_id = p_org and user_id = p_user) then
    raise exception 'Not in this company';
  end if;
  if p_user is null then
    delete from public.rep_targets where org_id = p_org and user_id is null;
  else
    delete from public.rep_targets where org_id = p_org and user_id = p_user;
  end if;
  if coalesce(p->>'calls', p->>'conversations', p->>'talk_minutes', p->>'sales') is not null then
    insert into public.rep_targets (org_id, user_id, calls, conversations, talk_minutes, sales, updated_by)
    values (p_org, p_user, nullif(p->>'calls', '')::int, nullif(p->>'conversations', '')::int,
            nullif(p->>'talk_minutes', '')::int, nullif(p->>'sales', '')::int, auth.uid());
  end if;
end $$;

-- Target vs actual for a period (dates in the company's time zone, inclusive), per visible person.
create or replace function public.target_progress(p_org uuid, p_from date, p_to date, p_users uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; v_days int; v_wd int[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'Choose up to 3 months'; end if;
  select timezone, coalesce((select array_agg(x::int) from jsonb_array_elements_text(settings->'work_days') x), array[1,2,3,4,5,6])
    into v_tz, v_wd from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  select count(*) into v_days from generate_series(p_from, p_to, interval '1 day') d where extract(isodow from d)::int = any(v_wd);

  with people as (
    select m.user_id from public.org_members m where m.org_id = p_org and m.status = 'active' and m.user_id = any(v_users)
  ), t as (
    select p.user_id,
      coalesce(r.calls, d.calls) as calls, coalesce(r.conversations, d.conversations) as conversations,
      coalesce(r.talk_minutes, d.talk_minutes) as talk_minutes, coalesce(r.sales, d.sales) as sales,
      r.id is not null as own
    from people p
    left join public.rep_targets r on r.org_id = p_org and r.user_id = p.user_id
    left join public.rep_targets d on d.org_id = p_org and d.user_id is null
  ), a as (
    select c.user_id,
      count(*) filter (where c.direction = 'outgoing') as calls,
      count(*) filter (where c.duration_sec > 0) as conversations,
      coalesce(sum(c.duration_sec), 0) / 60 as talk_minutes,
      count(*) filter (where o.category = 'won') as sales
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.user_id = any(v_users)
      and c.started_at >= (p_from::timestamp at time zone v_tz) and c.started_at < ((p_to + 1)::timestamp at time zone v_tz)
    group by c.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'own_target', t.own,
      'target', jsonb_build_object('calls', t.calls * v_days, 'conversations', t.conversations * v_days,
                                   'talk_minutes', t.talk_minutes * v_days, 'sales', t.sales * v_days),
      'daily', jsonb_build_object('calls', t.calls, 'conversations', t.conversations, 'talk_minutes', t.talk_minutes, 'sales', t.sales),
      'actual', jsonb_build_object('calls', coalesce(a.calls, 0), 'conversations', coalesce(a.conversations, 0),
                                   'talk_minutes', coalesce(a.talk_minutes, 0), 'sales', coalesce(a.sales, 0))
    )), '[]'::jsonb) into res
  from t left join a on a.user_id = t.user_id;
  return jsonb_build_object('work_days', v_days, 'rows', res);
end $$;

revoke execute on function public.set_rep_target(uuid, uuid, jsonb) from anon, public;
revoke execute on function public.target_progress(uuid, date, date, uuid[]) from anon, public;
grant execute on function public.set_rep_target(uuid, uuid, jsonb) to authenticated;
grant execute on function public.target_progress(uuid, date, date, uuid[]) to authenticated;
