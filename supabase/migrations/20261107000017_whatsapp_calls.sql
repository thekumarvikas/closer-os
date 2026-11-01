-- WhatsApp calls: the app reads WhatsApp's call notifications (with the rep's permission) and
-- uploads them like phone calls, marked channel = 'whatsapp'. Company setting
-- organizations.settings.track_whatsapp (default on). WhatsApp calls can't be recorded.
alter table public.calls add column if not exists channel text not null default 'phone';
alter table public.calls add column if not exists contact_name text;
alter table public.calls drop constraint if exists calls_channel_check;
alter table public.calls add constraint calls_channel_check check (channel in ('phone', 'whatsapp'));

create or replace function public.sync_calls(p_org uuid, p_calls jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text; v_wa boolean; v_prefix text; r jsonb; v_phone text; v_lead uuid; v_dir public.call_direction; v_dur int;
  v_channel text; n int := 0; skipped int := 0; out jsonb := '[]'::jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member of this company'; end if;
  if jsonb_array_length(p_calls) > 500 then raise exception 'Send at most 500 calls at a time'; end if;
  select coalesce(settings->>'call_tracking', 'all'), coalesce((settings->>'track_whatsapp')::boolean, true), phone_prefix into v_mode, v_wa, v_prefix from public.organizations where id = p_org;

  for r in select * from jsonb_array_elements(p_calls) loop
    v_channel := coalesce(nullif(r->>'channel', ''), 'phone');
    if v_channel not in ('phone', 'whatsapp') then skipped := skipped + 1; continue; end if;
    if v_channel = 'whatsapp' and not v_wa then skipped := skipped + 1; continue; end if;
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then skipped := skipped + 1; continue; end if;   -- private / unknown caller
    v_dir := (r->>'direction')::public.call_direction;
    v_dur := case when v_dir in ('missed', 'rejected') then 0 else greatest(0, coalesce((r->>'duration_sec')::int, 0)) end;

    select id into v_lead from public.leads where org_id = p_org and phone = v_phone and deleted_at is null;
    if v_lead is null then
      select lp.lead_id into v_lead from public.lead_phones lp
      join public.leads l on l.id = lp.lead_id and l.deleted_at is null
      where lp.org_id = p_org and lp.phone = v_phone;
    end if;
    if v_lead is null and v_mode = 'leads' then skipped := skipped + 1; continue; end if;

    insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                              duration_sec, sim_slot, sim_label, sim_number, recording_status, channel, contact_name)
    values ((r->>'id')::uuid, p_org, v_lead, auth.uid(), r->>'device_id', v_dir, v_phone, (r->>'started_at')::timestamptz,
            (r->>'started_at')::timestamptz + make_interval(secs => v_dur), v_dur,
            nullif(r->>'sim_slot', '')::int, nullif(r->>'sim_label', ''), public.normalize_phone(nullif(r->>'sim_number', ''), v_prefix), 'not_expected',
            v_channel, nullif(r->>'contact_name', ''))
    on conflict (id) do update set
      duration_sec = greatest(public.calls.duration_sec, excluded.duration_sec),
      lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
      sim_slot = coalesce(public.calls.sim_slot, excluded.sim_slot),
      sim_label = coalesce(public.calls.sim_label, excluded.sim_label),
      sim_number = coalesce(public.calls.sim_number, excluded.sim_number)
    where public.calls.user_id = auth.uid();

    if v_lead is not null then
      update public.leads set last_call_at = greatest(coalesce(last_call_at, '-infinity'), (r->>'started_at')::timestamptz)
      where id = v_lead;
    end if;
    n := n + 1;
    out := out || jsonb_build_array(jsonb_build_object('id', r->>'id', 'lead_id', v_lead));
  end loop;
  return jsonb_build_object('synced', n, 'skipped', skipped, 'calls', out);
end $$;


-- Reports can be limited to phone or WhatsApp calls.
drop function if exists public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean);
drop function if exists public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean, text[]);
create or replace function public.call_report(
  p_org uuid, p_from timestamptz, p_to timestamptz,
  p_users uuid[] default null, p_lead_only boolean default false, p_dirs text[] default null, p_channels text[] default null
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
      and (p_channels is null or c.channel = any(p_channels))
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
drop function if exists public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[]);
create or replace function public.outcome_report(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null, p_dirs text[] default null, p_channels text[] default null
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
      and (p_channels is null or c.channel = any(p_channels))
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

revoke execute on function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean, text[], text[]) from anon, public;
revoke execute on function public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[], text[]) from anon, public;
grant execute on function public.call_report(uuid, timestamptz, timestamptz, uuid[], boolean, text[], text[]) to authenticated;
grant execute on function public.outcome_report(uuid, timestamptz, timestamptz, uuid[], text[], text[]) to authenticated;
