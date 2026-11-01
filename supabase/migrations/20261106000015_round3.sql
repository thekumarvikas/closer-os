-- Round 3: personal WhatsApp templates; reports can be limited to dialled or incoming calls.

-- ───────────── Company + personal WhatsApp messages ─────────────
-- owner_id null = company message (managers control it); owner_id = a person = their own message.
alter table public.message_templates add column if not exists owner_id uuid references auth.users(id) on delete cascade;
drop policy if exists templates_select on public.message_templates;
create policy templates_select on public.message_templates for select using (
  public.is_org_member(org_id) and (owner_id is null or owner_id = auth.uid())
);
drop policy if exists templates_write on public.message_templates;
create policy templates_write on public.message_templates for all
  using ((owner_id is null and public.is_org_manager(org_id)) or (owner_id = auth.uid() and public.is_org_member(org_id)))
  with check ((owner_id is null and public.is_org_manager(org_id)) or (owner_id = auth.uid() and public.is_org_member(org_id)));

-- ───────────── Reports by call direction ─────────────
drop function if exists public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean);
create or replace function public.call_report(
  p_org uuid, p_from timestamptz, p_to timestamptz,
  p_users uuid[] default null, p_lead_only boolean default false, p_dirs text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to <= p_from then raise exception 'The end date must be after the start date'; end if;
  if p_to - p_from > interval '93 days' then raise exception 'Choose a period of at most 3 months'; end if;

  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then
    v_users := array(select unnest(v_users) intersect select unnest(p_users));
  end if;

  with c as (
    select
      c.id, c.user_id, c.phone, c.direction, c.duration_sec, c.started_at,
      c.lead_id is not null as is_lead,
      c.direction in ('incoming', 'outgoing') and c.duration_sec > 0 as connected,
      (c.started_at at time zone v_tz)::date as day,
      extract(hour from c.started_at at time zone v_tz)::int as hr,
      c.direction in ('missed', 'rejected') and not exists (
        select 1 from public.calls r
        where r.org_id = p_org and r.phone = c.phone and r.started_at > c.started_at
          and (r.direction = 'outgoing' or (r.direction = 'incoming' and r.duration_sec > 0))
      ) as never_attended
    from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
      and c.user_id = any(v_users)
      and (not p_lead_only or c.lead_id is not null)
      and (p_dirs is null or c.direction::text = any(p_dirs))
  ),
  agg as (
    select
      grouping(user_id, day, hr, is_lead) as g, user_id, day, hr, is_lead,
      count(*) as calls,
      coalesce(sum(duration_sec), 0) as dur,
      count(*) filter (where direction = 'incoming') as inc,
      coalesce(sum(duration_sec) filter (where direction = 'incoming'), 0) as inc_dur,
      count(*) filter (where direction = 'incoming' and duration_sec > 0) as inc_conn,
      count(*) filter (where direction = 'outgoing') as out,
      coalesce(sum(duration_sec) filter (where direction = 'outgoing'), 0) as out_dur,
      count(*) filter (where direction = 'outgoing' and duration_sec > 0) as out_conn,
      count(*) filter (where direction = 'missed') as missed,
      count(*) filter (where direction = 'rejected') as rejected,
      count(*) filter (where connected) as conn,
      coalesce(sum(duration_sec) filter (where connected), 0) as conn_dur,
      count(*) filter (where direction = 'outgoing' and duration_sec = 0) as not_picked,
      count(*) filter (where never_attended) as never_attended,
      count(distinct phone) as uniq,
      count(distinct phone) filter (where connected) as uniq_conn
    from c
    group by grouping sets ((), (is_lead), (user_id), (user_id, is_lead), (day), (day, is_lead),
                            (day, user_id), (day, user_id, is_lead), (hr), (hr, is_lead))
  ),
  work as (
    select user_id, day, is_lead,
      extract(epoch from max(started_at + make_interval(secs => duration_sec)) - min(started_at))::int as work_sec
    from c group by grouping sets ((user_id, day), (user_id, day, is_lead))
  )
  select jsonb_build_object(
    'tz', v_tz,
    'rows', coalesce((select jsonb_agg(to_jsonb(agg)) from agg), '[]'::jsonb),
    'work', coalesce((select jsonb_agg(to_jsonb(work)) from work), '[]'::jsonb)
  ) into res;
  return res;
end $$;

drop function if exists public.outcome_report(uuid, timestamptz, timestamptz, uuid[]);
create or replace function public.outcome_report(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null, p_dirs text[] default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to <= p_from then raise exception 'The end date must be after the start date'; end if;
  if p_to - p_from > interval '93 days' then raise exception 'Choose a period of at most 3 months'; end if;

  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then
    v_users := array(select unnest(v_users) intersect select unnest(p_users));
  end if;

  with c as (
    select c.user_id, c.lead_id, c.outcome_id, c.duration_sec,
      (c.started_at at time zone v_tz)::date as day,
      coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) as amount,
      coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) as deal_value
    from public.calls c
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
      and c.user_id = any(v_users) and c.lead_id is not null
      and (p_dirs is null or c.direction::text = any(p_dirs))
  ),
  agg as (
    select grouping(user_id, day, outcome_id) as g, user_id, day, outcome_id,
      count(*) as calls,
      count(distinct lead_id) as leads,
      sum(amount) as amount,
      sum(deal_value) as deal_value,
      coalesce(sum(duration_sec), 0) as dur
    from c
    group by grouping sets ((outcome_id), (user_id, outcome_id), (day, outcome_id), (user_id), (day), ())
  )
  select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(agg)), '[]'::jsonb)) into res from agg;
  return res;
end $$;

revoke execute on function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean, text[]) from anon, public;
revoke execute on function public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[]) from anon, public;
grant execute on function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean, text[]) to authenticated;
grant execute on function public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[]) to authenticated;
