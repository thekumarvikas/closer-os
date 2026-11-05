-- Reminder vs sales, worked out per lead (calls from Focus, Follow-ups, the pop-up, the laptop desk…).
-- Reminder = the lead has a reminder follow-up due within 24 h, or is registered (not in a test group)
-- for a webinar/event starting within 24 h. Otherwise sales (tagged with the webinar of the last 30 days).
create or replace function public.lead_call_context(p_lead uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_up uuid; v_past uuid; v_rem boolean;
begin
  if not public.lead_visible(p_lead) then return jsonb_build_object('purpose', 'sales'); end if;
  select b.id into v_up from public.batch_leads bl join public.batches b on b.id = bl.batch_id
   where bl.lead_id = p_lead and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '24 hours'
   order by b.webinar_at limit 1;
  v_rem := v_up is not null or exists (select 1 from public.follow_ups f where f.lead_id = p_lead and f.status = 'pending'
                                        and f.purpose = 'reminder' and f.due_at < now() + interval '24 hours');
  if v_rem then
    if v_up is null then
      select b.id into v_up from public.batch_leads bl join public.batches b on b.id = bl.batch_id
       where bl.lead_id = p_lead and b.webinar_at > now() order by b.webinar_at limit 1;
    end if;
    return jsonb_build_object('purpose', 'reminder', 'batch_id', v_up);
  end if;
  select b.id into v_past from public.batch_leads bl join public.batches b on b.id = bl.batch_id
   where bl.lead_id = p_lead and b.webinar_at <= now() and b.webinar_at > now() - interval '30 days' order by b.webinar_at desc limit 1;
  return jsonb_build_object('purpose', 'sales', 'batch_id', v_past);
end $$;
grant execute on function public.lead_call_context(uuid) to authenticated;

-- Laptop desk: "Call on my phone" without a purpose → worked out the same way.
create or replace function public.request_call(p_lead uuid, p_purpose text default null, p_batch uuid default null)
 returns uuid language plpgsql security definer set search_path = '' as $function$
declare v_org uuid; v_id uuid; v_ctx jsonb;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select org_id into v_org from public.leads where id = p_lead and deleted_at is null;
  if exists (select 1 from public.leads where id = p_lead and do_not_call) then raise exception 'This lead is marked Do Not Call'; end if;
  if p_purpose is null then v_ctx := public.lead_call_context(p_lead); end if;
  update public.call_requests set status = 'cancelled', updated_at = now() where user_id = auth.uid() and status = 'pending';
  insert into public.call_requests (org_id, user_id, lead_id, purpose, batch_id)
  values (v_org, auth.uid(), p_lead, coalesce(p_purpose, v_ctx->>'purpose', 'sales'), coalesce(p_batch, nullif(v_ctx->>'batch_id', '')::uuid))
  returning id into v_id;
  return v_id;
end $function$;

-- The lead's next call time always follows its pending follow-ups (also when the dashboard marks one done).
create or replace function public.t_fu_sync_lead() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.leads set next_follow_up_at = (select min(due_at) from public.follow_ups where lead_id = v_lead and status = 'pending')
   where id = v_lead and next_follow_up_at is distinct from (select min(due_at) from public.follow_ups where lead_id = v_lead and status = 'pending');
  return null;
end $$;
drop trigger if exists t_fu_sync_lead on public.follow_ups;
create trigger t_fu_sync_lead after insert or update of status, due_at or delete on public.follow_ups
  for each row execute function public.t_fu_sync_lead();
update public.leads l set next_follow_up_at = x.m from (
  select l2.id, (select min(due_at) from public.follow_ups f where f.lead_id = l2.id and f.status = 'pending') m from public.leads l2) x
 where x.id = l.id and l.next_follow_up_at is distinct from x.m;

-- Once a webinar has started, its leftover reminder follow-ups are closed (no more "Not called" clutter).
create or replace function public.close_stale_reminders() returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.follow_ups f set status = 'cancelled', completed_at = now(), notes = concat_ws(' · ', nullif(f.notes, ''), 'Closed: the webinar started')
   where f.status = 'pending' and f.purpose = 'reminder'
     and exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
                  where bl.lead_id = f.lead_id and b.webinar_at <= now() and b.webinar_at > f.created_at
                    and not exists (select 1 from public.batch_leads bl2 join public.batches b2 on b2.id = bl2.batch_id
                                     where bl2.lead_id = f.lead_id and b2.webinar_at > now()));
  get diagnostics n = row_count;
  return n;
end $$;
select cron.unschedule('close-stale-reminders') where exists (select 1 from cron.job where jobname = 'close-stale-reminders');
select cron.schedule('close-stale-reminders', '*/15 * * * *', 'select public.close_stale_reminders()');

-- Focus order: late follow-ups → tonight's reminder calls → due in 2 h → hot watchers → new leads (newest first) → best time now → close to converting → rest.
CREATE OR REPLACE FUNCTION public.my_focus_list(p_org uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_day_start timestamptz; v_day_end timestamptz;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_day_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';
  return (with mine as (
      select l.*, o.category cat,
        -- tonight's webinar (starts within 18 h; reminder calls) and the best recent watch time (last 14 days)
        (select b.webinar_at from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'
          order by b.webinar_at limit 1) up_at,
        (select b.name from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and not coalesce(bl.is_holdout, false) and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'
          order by b.webinar_at limit 1) up_name,
        (select max(bl.watch_minutes) from public.batch_leads bl join public.batches b on b.id = bl.batch_id
          where bl.lead_id = l.id and b.webinar_at > now() - interval '14 days' and b.webinar_at <= now() and coalesce(bl.watch_minutes, 0) >= coalesce(b.hot_minutes, 60)) hot_min
      from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
      where l.org_id = p_org and l.deleted_at is null and not l.do_not_call
        and (l.assigned_to = auth.uid() or exists (select 1 from public.batch_leads bl join public.batches b on b.id = bl.batch_id
              where bl.lead_id = l.id and bl.reminder_by = auth.uid() and b.webinar_at > now() and b.webinar_at < now() + interval '18 hours'))
        and coalesce(o.category::text, '') not in ('won', 'lost', 'invalid')
    ), todo as (
      select m.*, public.lead_call_context(m.id)->>'purpose' call_purpose, public.lead_call_context(m.id)->>'batch_id' call_batch_id, case
          when m.next_follow_up_at < now() then 1
          when m.up_at is not null then 2
          when m.next_follow_up_at < now() + interval '2 hours' then 3
          when m.hot_min is not null then 4
          when m.dial_count = 0 then 5
          when m.best_hour = extract(hour from now() at time zone v_tz)::int then 6
          when m.score >= 40 then 7 else 8 end bucket,
        case when m.next_follow_up_at < now() then 'Overdue follow-up'
             when m.up_at is not null then '🎓 Reminder · ' || m.up_name || ' at ' || to_char(m.up_at at time zone v_tz, 'FMHH12:MI AM')
             when m.next_follow_up_at < now() + interval '2 hours' then 'Follow-up due'
             when m.hot_min is not null then '🔥 Watched ' || m.hot_min || ' min'
             when m.dial_count = 0 then 'New — not called yet'
             when m.best_hour = extract(hour from now() at time zone v_tz)::int then '⏰ Best time to call now' when m.score >= 40 then '⚡ Close to converting' else null end reason
      from mine m
      where (m.next_follow_up_at is null or m.next_follow_up_at < v_day_end)      -- planned for a later day: not today
        and (m.last_call_at is null or m.last_call_at < v_day_start or m.next_follow_up_at < now() + interval '2 hours')
    )
    select jsonb_build_object(
      'total', (select count(*) from todo),
      'done_today', (select count(*) from mine where last_call_at >= v_day_start),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) - 'up_at' - 'up_name' - 'hot_min' order by t.bucket, t.up_at nulls last, t.next_follow_up_at nulls last,
                  t.hot_min desc nulls last, case when t.bucket = 5 then -extract(epoch from t.created_at) end, t.score desc, t.last_call_at nulls first), '[]')
               from (select * from todo order by bucket, up_at nulls last, next_follow_up_at nulls last, hot_min desc nulls last,
                     case when bucket = 5 then -extract(epoch from created_at) end, score desc, last_call_at nulls first
                     limit p_limit offset p_offset) t)
    ));
end $function$;
