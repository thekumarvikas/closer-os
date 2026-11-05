-- Conversations per lead = dialled real pick-ups + incoming calls where they talked (shown on every lead).
alter table public.leads add column if not exists conversation_count int not null default 0;
CREATE OR REPLACE FUNCTION public.refresh_lead_stats(p_lead uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_last record; v_cat public.outcome_category; v_watch int; v_score numeric := 0; v_dnc boolean; v_lc timestamptz;
begin
  if p_lead is null then return; end if;
  select coalesce(sum(c.duration_sec), 0) talk,
         count(*) filter (where c.direction = 'outgoing') dials,
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, o.category)) picks,
         min(c.started_at) filter (where c.direction = 'outgoing') first_dial,
         min(c.started_at) filter (where o.category = 'won') won
    into s
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id where c.lead_id = p_lead;

  select c.direction, c.duration_sec, o.category into v_last
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.lead_id = p_lead order by c.started_at desc limit 1;

  select o.category, l.do_not_call, l.last_connected_at into v_cat, v_dnc, v_lc
  from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id where l.id = p_lead;
  select max(watch_minutes) into v_watch from public.batch_leads where lead_id = p_lead;

  -- Close-to-converting score (open leads only).
  if not coalesce(v_dnc, false) and coalesce(v_cat::text, '') not in ('won', 'lost', 'invalid') then
    v_score := least(s.picks, 3) * 12
             + least(s.talk / 60.0 / 30.0, 1) * 24
             + case v_cat when 'positive' then 20 when 'connected' then 8 else 0 end
             + case when coalesce(v_watch, 0) >= 60 then 15 when coalesce(v_watch, 0) > 0 then 6 else 0 end
             + case when v_lc > now() - interval '3 days' then 5 else 0 end;
  end if;

  update public.leads l set
    total_talk_sec = s.talk, dial_count = s.dials, pickup_count = s.picks,
    first_dialled_at = s.first_dial, won_at = s.won,
    first_talk_dial = (select n from (
        select row_number() over (order by c.started_at) n, public.is_real_pickup(c.direction, c.duration_sec, o.category) p
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = p_lead and c.direction = 'outgoing') x where p order by n limit 1),
    last_call_status = case
        when v_last.direction is null then null
        when v_last.direction in ('missed', 'rejected') then 'missed'
        when v_last.direction = 'incoming' then case when coalesce(v_last.duration_sec, 0) > 0 then 'talked' else 'missed' end
        when public.is_real_pickup(v_last.direction, v_last.duration_sec, v_last.category) then 'talked'
        else 'not_picked' end,
    wa_count = (select count(*) from public.wa_messages w where w.lead_id = p_lead and w.undone_at is null),
    score = round(v_score)::int,
    conversation_count = (select count(*) from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = p_lead and (public.is_real_pickup(c.direction, c.duration_sec, o.category)
          or (c.direction = 'incoming' and case when o.category is not null then o.category in ('connected', 'positive', 'won', 'lost') else coalesce(c.duration_sec, 0) >= 20 end))),
    best_hour = (select hr from (
        select extract(hour from c.started_at at time zone coalesce(o2.timezone, 'Asia/Kolkata'))::int hr, count(*) n
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        join public.leads l2 on l2.id = c.lead_id join public.organizations o2 on o2.id = l2.org_id
        where c.lead_id = p_lead and public.is_real_pickup(c.direction, c.duration_sec, o.category)
        group by 1 having count(*) >= 2 order by 2 desc, 1 limit 1) b)
  where l.id = p_lead;
end $function$;

do $$ declare l record; begin
  for l in select id from public.leads where deleted_at is null and (dial_count > 0 or total_talk_sec > 0) loop perform public.refresh_lead_stats(l.id); end loop;
end $$;
