-- Show-up impact: did reminder calls bring people to the webinar?
--
-- "Joined" = watched more than 0 minutes (any time in the webinar counts).
-- "Stayed" = watched at least the batch's hot_minutes (default 60).
-- Only reminder calls made BEFORE the webinar start count.
-- Optional test group (off by default): a random X% of a batch's leads is left out of reminder
-- calls, to measure the real effect of calling. holdout_pct = 0 means off.

alter table public.batches add column if not exists holdout_pct int not null default 0 check (holdout_pct between 0 and 50);
alter table public.batch_leads add column if not exists is_holdout boolean not null default false;

-- New batch leads join the test group at random when it is on.
create or replace function public.batch_lead_holdout()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_pct int;
begin
  select holdout_pct into v_pct from public.batches where id = new.batch_id;
  new.is_holdout := coalesce(v_pct, 0) > 0 and random() * 100 < v_pct;
  if new.is_holdout then new.reminder_by := null; end if;
  return new;
end $$;
drop trigger if exists t_batch_lead_holdout on public.batch_leads;
create trigger t_batch_lead_holdout before insert on public.batch_leads
  for each row execute function public.batch_lead_holdout();

-- Changing the percentage re-draws the test group among leads with no reminder call yet.
create or replace function public.batch_holdout_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if new.holdout_pct is distinct from old.holdout_pct then
    update public.batch_leads set is_holdout = false where batch_id = new.id;
    if new.holdout_pct > 0 then
      select round(count(*) * new.holdout_pct / 100.0) into v_n from public.batch_leads where batch_id = new.id;
      update public.batch_leads set is_holdout = true, reminder_by = null
      where batch_id = new.id and lead_id in (
        select bl.lead_id from public.batch_leads bl
        where bl.batch_id = new.id and not exists (
          select 1 from public.calls c where c.batch_id = new.id and c.lead_id = bl.lead_id and c.purpose = 'reminder')
        order by random() limit v_n);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_batch_holdout on public.batches;
create trigger t_batch_holdout after update of holdout_pct on public.batches
  for each row execute function public.batch_holdout_changed();

-- Reminder assignment skips the test group.
create or replace function public.assign_reminders(p_batch uuid, p_user_ids uuid[], p_overwrite boolean default false)
returns int language plpgsql security definer set search_path = '' as $$
declare v_org uuid; n int; i int := 0; x record;
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  n := coalesce(cardinality(p_user_ids), 0);
  if n = 0 then raise exception 'Choose at least one person'; end if;
  for x in select lead_id from public.batch_leads
           where batch_id = p_batch and not is_holdout and (p_overwrite or reminder_by is null) order by added_at loop
    update public.batch_leads set reminder_by = p_user_ids[(i % n) + 1] where batch_id = p_batch and lead_id = x.lead_id;
    i := i + 1;
  end loop;
  perform public.write_audit(v_org, 'batch.reminders_assigned', 'batch', p_batch::text, jsonb_build_object('count', i, 'users', p_user_ids));
  return i;
end $$;

-- ───────────────────────── The report ─────────────────────────
create or replace function public.show_up_report(p_batch uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_hot int; v_at timestamptz; v_tz text; v_users uuid[]; res jsonb;
begin
  select b.org_id, b.hot_minutes, b.webinar_at, o.timezone into v_org, v_hot, v_at, v_tz
  from public.batches b join public.organizations o on o.id = b.org_id where b.id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(v_org);

  with f0 as (
    select bl.lead_id, bl.is_holdout, bl.is_repeat, bl.added_at,
      coalesce(bl.reminder_by, l.assigned_to) as caller,
      coalesce(bl.watch_minutes, 0) > 0 as joined,
      coalesce(bl.watch_minutes, 0) >= v_hot and coalesce(bl.watch_minutes, 0) > 0 as stayed,
      l.profession_category_id, coalesce(nullif(l.source, ''), 'Unknown') as source
    from public.batch_leads bl join public.leads l on l.id = bl.lead_id and l.deleted_at is null
    where bl.batch_id = p_batch
  ),
  f1 as (
    select * from f0 where (caller is null and public.is_org_manager(v_org)) or caller = any(v_users)
  ),
  rc as (   -- reminder calls before the webinar
    select c.lead_id, count(*)::int as calls,
      count(*) filter (where c.duration_sec > 0)::int as connected,
      coalesce(sum(c.duration_sec), 0)::int as talk,
      max(c.started_at) as last_at,
      max(c.started_at) filter (where c.duration_sec > 0) as last_conn_at,
      (array_agg(c.outcome_id order by c.started_at desc) filter (where c.outcome_id is not null))[1] as outcome_id
    from public.calls c
    where c.batch_id = p_batch and c.purpose = 'reminder' and c.started_at < v_at
      and c.lead_id in (select lead_id from f1)
    group by c.lead_id
  ),
  f as (
    select f1.*, coalesce(rc.calls, 0) as calls, coalesce(rc.connected, 0) as connected, coalesce(rc.talk, 0) as talk,
      rc.last_at, rc.last_conn_at, rc.outcome_id,
      case when f1.is_holdout then 'holdout' when coalesce(rc.calls, 0) = 0 then 'not_called' else 'called' end as grp
    from f1 left join rc on rc.lead_id = f1.lead_id
  ),
  by_caller as (
    select grouping(caller) as g, caller, grp, count(*) as leads, count(*) filter (where connected > 0) as connected,
      count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed
    from f group by grouping sets ((caller, grp), (grp))
  ),
  by_outcome as (
    select grouping(caller) as g, caller, outcome,
      count(*) as leads, count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed
    from (select caller, joined, stayed,
            case when grp = 'called' then coalesce(outcome_id::text, 'no_outcome') else grp end as outcome
          from f) o
    group by grouping sets ((caller, outcome), (outcome))
  ),
  dims as (
    -- Timing: how long before the webinar the last reminder call was made.
    select 'timing' as dim,
      case when grp <> 'called' then 'z_not_called'
           when v_at - last_at <= interval '3 hours' then 'a_lt3h'
           when v_at - last_at <= interval '12 hours' then 'b_3_12h'
           when v_at - last_at <= interval '24 hours' then 'c_12_24h'
           when v_at - last_at <= interval '48 hours' then 'd_1_2d'
           else 'e_2d_plus' end as bucket, joined, stayed from f where not is_holdout
    union all
    select 'attempts', case when calls = 0 then 'a_0' when calls = 1 then 'b_1' when calls = 2 then 'c_2' else 'd_3plus' end, joined, stayed from f where not is_holdout
    union all
    select 'talk', case when calls = 0 then 'z_not_called' when connected = 0 then 'a_never_answered' when talk < 60 then 'b_lt1m' when talk < 180 then 'c_1_3m' else 'd_3m_plus' end, joined, stayed from f where not is_holdout
    union all
    select 'hour', case when last_conn_at is null then 'z_no_conversation'
           when extract(hour from last_conn_at at time zone v_tz) < 12 then 'a_morning'
           when extract(hour from last_conn_at at time zone v_tz) < 17 then 'b_afternoon'
           when extract(hour from last_conn_at at time zone v_tz) < 21 then 'c_evening'
           else 'd_night' end, joined, stayed from f where not is_holdout
    union all
    select 'profession', coalesce(profession_category_id::text, 'z_none'), joined, stayed from f where not is_holdout
    union all
    select 'source', source, joined, stayed from f where not is_holdout
    union all
    select 'repeat', case when is_repeat then 'b_repeat' else 'a_new' end, joined, stayed from f where not is_holdout
    union all
    select 'registered', case when v_at - added_at <= interval '24 hours' then 'a_lt1d'
           when v_at - added_at <= interval '3 days' then 'b_1_3d'
           when v_at - added_at <= interval '7 days' then 'c_3_7d' else 'd_7d_plus' end, joined, stayed from f where not is_holdout
  ),
  patterns as (
    select dim, bucket, count(*) as leads, count(*) filter (where joined) as joined, count(*) filter (where stayed) as stayed
    from dims group by dim, bucket
  )
  select jsonb_build_object(
    'zoom_uploaded', (select zoom_uploaded_at is not null from public.batches where id = p_batch),
    'by_caller', coalesce((select jsonb_agg(to_jsonb(by_caller)) from by_caller), '[]'::jsonb),
    'by_outcome', coalesce((select jsonb_agg(to_jsonb(by_outcome)) from by_outcome), '[]'::jsonb),
    'patterns', coalesce((select jsonb_agg(to_jsonb(patterns)) from patterns), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- Show-up per reminder caller across the latest webinars that have a Zoom report.
create or replace function public.show_up_trend(p_org uuid, p_limit int default 8)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  with b as (
    select id, name, webinar_at from public.batches
    where org_id = p_org and zoom_uploaded_at is not null order by webinar_at desc limit least(p_limit, 20)
  ),
  x as (
    select b.id as batch_id, coalesce(bl.reminder_by, l.assigned_to) as caller, coalesce(bl.watch_minutes, 0) > 0 as joined,
      exists (select 1 from public.calls c where c.batch_id = b.id and c.lead_id = bl.lead_id and c.purpose = 'reminder' and c.started_at < b.webinar_at) as called
    from b join public.batch_leads bl on bl.batch_id = b.id and not bl.is_holdout
    join public.leads l on l.id = bl.lead_id and l.deleted_at is null
  ),
  agg as (
    select grouping(caller) as g, batch_id, caller, count(*) as leads, count(*) filter (where called) as called, count(*) filter (where joined) as joined
    from x where (caller is null and public.is_org_manager(p_org)) or caller = any(v_users)
    group by grouping sets ((batch_id, caller), (batch_id))
  )
  select jsonb_build_object(
    'batches', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'webinar_at', webinar_at) order by webinar_at) from b), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('batch_id', batch_id, 'caller', caller, 'total', g = 1,
      'leads', leads, 'called', called, 'joined', joined)) from agg), '[]'::jsonb)
  ) into res;
  return res;
end $$;

revoke execute on function public.show_up_report(uuid) from anon, public;
revoke execute on function public.show_up_trend(uuid, int) from anon, public;
grant execute on function public.show_up_report(uuid) to authenticated;
grant execute on function public.show_up_trend(uuid, int) to authenticated;
