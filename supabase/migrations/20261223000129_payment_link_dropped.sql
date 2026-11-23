-- "Payment link dropped" (owner, Nov 23 2026): who was in the room when the payment link was dropped in the chat.
alter table public.batch_leads add column if not exists pitch_est boolean not null default false;
alter table public.batches add column if not exists pay_link text;
alter table public.wa_sequences add column if not exists auto_link boolean not null default false;

CREATE OR REPLACE FUNCTION public.batch_recompute(p_batch uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b record; v_pitch_at timestamptz; v_ref int;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null then return; end if;
  v_pitch_at := case when b.pitch_minute is null then null
                     else coalesce(b.started_at, b.webinar_at) + make_interval(mins => b.pitch_minute) end;
  v_ref := greatest(coalesce(b.pitch_minute, b.hot_minutes, 60), 1);

  update public.batch_leads bl set
    chat_count = (select count(*) from public.batch_chat c where c.batch_id = p_batch and c.lead_id = bl.lead_id),
    poll_answered = (select count(distinct p.question) from public.batch_poll_answers p where p.batch_id = p_batch and p.lead_id = bl.lead_id)
  where bl.batch_id = p_batch;

  -- Present when the payment link was dropped = in the room for the 10 minutes around it (5 before, 5 after);
  -- short drops (reconnects) are fine: at least 9 of those 10 minutes. Files without join/leave times:
  -- watched at least link minute + 5 = present, marked estimated (pitch_est).
  update public.batch_leads bl set
    at_pitch = case when v_pitch_at is null or bl.sessions is null or jsonb_array_length(bl.sessions) = 0 then null
                    else (select coalesce(sum(greatest(0, extract(epoch from
                            least((s->>'leave')::timestamptz, v_pitch_at + interval '5 minutes')
                            - greatest((s->>'join')::timestamptz, v_pitch_at - interval '5 minutes')))), 0)
                          from jsonb_array_elements(bl.sessions) s) >= 540 end
  where bl.batch_id = p_batch;

  update public.batch_leads bl set
    saw_pitch = case when b.pitch_minute is null or bl.watch_minutes is null then null
                     when coalesce(bl.watch_minutes, 0) = 0 then false
                     else coalesce(bl.at_pitch, bl.watch_minutes >= b.pitch_minute + 5) end,
    pitch_est = b.pitch_minute is not null and coalesce(bl.watch_minutes, 0) > 0 and bl.at_pitch is null
  where bl.batch_id = p_batch;

  update public.batch_leads bl set warmth = x.score, warm_reason = x.reason
  from (
    select bl2.lead_id,
      case when coalesce(bl2.watch_minutes, 0) = 0 and bl2.chat_count = 0 and bl2.poll_answered = 0 then 0 else least(100, round(
        least(coalesce(bl2.watch_minutes, 0)::numeric / v_ref, 1) * 40
        + case when bl2.saw_pitch then 25 else 0 end
        + case when bl2.chat_count >= 2 then 15 when bl2.chat_count = 1 then 10 else 0 end
        + case when bl2.poll_answered > 0 then 10 + least(bl2.poll_answered, 4) * 2.5 else 0 end))::int end score,
      bl2.watch_minutes w, bl2.saw_pitch sp, bl2.chat_count cc, bl2.poll_answered pa
    from public.batch_leads bl2 where bl2.batch_id = p_batch
  ) y, lateral (select y.score, case when y.score = 0 then null else
      (case when y.score >= 70 then '🔥 Hot' when y.score >= 40 then 'Warm' else 'Cold' end) || ' · ' || y.score
      || coalesce(' · watched ' || nullif(y.w, 0) || ' min', '')
      || case when y.sp then ' · saw the payment link' when y.sp = false and coalesce(y.w, 0) > 0 then ' · missed the payment link' else '' end
      || case when y.cc > 0 then ' · ' || y.cc || ' chat' || case when y.cc > 1 then 's' else '' end else '' end
      || case when y.pa > 0 then ' · answered ' || y.pa || ' poll' || case when y.pa > 1 then 's' else '' end else '' end end reason) x
  where bl.batch_id = p_batch and bl.lead_id = y.lead_id;

  perform public.reg_floor_lead(x.lead_id) from (select distinct lead_id from public.batch_leads where batch_id = p_batch) x;
  -- leads.updated_at moves so phones re-download the lead with its new warmth.
  update public.leads l set updated_at = now()
  where l.id in (select lead_id from public.batch_leads where batch_id = p_batch);
end $function$;

CREATE OR REPLACE FUNCTION public.hot_leads(p_org uuid, p_users uuid[], p_limit integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with team as (
    select lower(p.email) email, public.phone_key(p.phone) pk, lower(trim(p.full_name)) nm
    from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = p_org
    union select null, public.phone_key(s.sim_number), null from public.member_sims s where s.org_id = p_org
  ), cand as (
    select l.*, o.category::text ocat, o.code ocode, o.label olabel
    from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
    where l.org_id = p_org and l.assigned_to = any(p_users) and l.deleted_at is null and l.won_at is null
      and not coalesce(l.do_not_call, false)
      and coalesce(o.category::text, '') not in ('lost', 'invalid', 'won')
      and coalesce(l.intent, '') not in ('cold', 'nofit')
      and (l.intent in ('ready','hot','interested','approval','price','later') or o.category::text = 'positive'
           or o.code ~ 'call_back|call_later'
           or exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and (coalesce(bl.watch_minutes, 0) > 0 or bl.attended)))
      and not exists (select 1 from team t where (t.email is not null and t.email = lower(l.email)) or (t.pk is not null and t.pk = public.phone_key(l.phone))
                      or (t.nm is not null and t.nm = lower(trim(l.name))))
  ), w as (
    select bl.lead_id, count(*) reg,
      count(*) filter (where coalesce(bl.watch_minutes, 0) > 0 or bl.attended) att,
      coalesce(sum(bl.watch_minutes), 0) watch,
      max(bl.watch_minutes) best,
      (array_agg(bb.webinar_at order by bl.watch_minutes desc nulls last))[1] best_at,
      bool_or(coalesce(bl.saw_pitch, false)) pitch,
      coalesce(sum(bl.chat_count), 0) chats, coalesce(sum(bl.poll_answered), 0) polls,
      (array_agg(bb.webinar_at order by bb.webinar_at desc) filter (where coalesce(bl.watch_minutes, 0) > 0 or bl.attended))[1] last_at,
      (array_agg(bl.watch_minutes order by bb.webinar_at desc) filter (where coalesce(bl.watch_minutes, 0) > 0 or bl.attended))[1] last_min,
      (array_agg(coalesce(bl.saw_pitch, false) order by bb.webinar_at desc) filter (where coalesce(bl.watch_minutes, 0) > 0 or bl.attended))[1] last_pitch
    from public.batch_leads bl join public.batches bb on bb.id = bl.batch_id
    where bl.lead_id in (select id from cand) group by bl.lead_id
  ), t as (
    select c.lead_id, sum(c.duration_sec) talk,
      jsonb_agg(jsonb_build_object('user', c.user_id, 'sec', c.s) order by c.s desc) filter (where c.s > 0) by_user
    from (select lead_id, user_id, sum(duration_sec) duration_sec, sum(duration_sec) s from public.calls
          where lead_id in (select id from cand) and direction in ('incoming','outgoing') and duration_sec > 0
          group by lead_id, user_id) c group by c.lead_id
  ), k as (
    select c.*, coalesce(w.reg, 0) reg, coalesce(w.att, 0) att, coalesce(w.watch, 0) watch, w.best, w.best_at, w.last_at, w.last_min, w.last_pitch,
      coalesce(w.pitch, false) pitch, coalesce(w.chats, 0) chats, coalesce(w.polls, 0) polls,
      coalesce(t.talk, 0) talk, t.by_user,
      (select max(x.started_at) from public.calls x where x.lead_id = c.id and x.duration_sec > 0) last_talk,
      case
        when c.intent = 'ready' then 1
        when coalesce(w.last_pitch, false) and w.last_at > now() - interval '30 days' then 9
        when c.intent = 'hot' then 2
        when c.intent = 'interested' or (c.ocat = 'positive' and c.ocode ~ 'interest') then 3
        when c.intent in ('approval','price','later') or c.ocat = 'positive' or c.ocode ~ 'call_back|call_later' then 4
        when coalesce(t.talk, 0) = 0 and coalesce(w.att, 0) >= 2 and (coalesce(w.chats, 0) + coalesce(w.polls, 0)) > 0 then 5
        when coalesce(t.talk, 0) = 0 and coalesce(w.att, 0) >= 2 then 6
        when coalesce(t.talk, 0) = 0 and coalesce(w.att, 0) = 1 and (coalesce(w.chats, 0) + coalesce(w.polls, 0)) > 0 then 7
        when coalesce(t.talk, 0) > 0 and coalesce(w.att, 0) > 0 then 8
      end cat
    from cand c left join w on w.lead_id = c.id left join t on t.lead_id = c.id
  ), hot as (select * from k where cat is not null)
  select jsonb_build_object(
    'total', (select count(*) from hot),
    'talked_24h', (select count(*) from hot where last_talk > now() - interval '24 hours'),
    'by_cat', coalesce((select jsonb_object_agg(cat, n) from (select cat, count(*) n from hot group by cat) z), '{}'),
    'by_owner', coalesce((select jsonb_agg(jsonb_build_object('owner', assigned_to, 'cat', cat, 'n', n)) from (select assigned_to, cat, count(*) n from hot group by 1, 2) z), '[]'),
    'list', coalesce((select jsonb_agg(jsonb_build_object(
      'lead_id', h.id, 'name', coalesce(nullif(h.name, ''), h.phone), 'phone', h.phone, 'owner', h.assigned_to, 'cat', h.cat,
      'tag', case h.intent when 'ready' then 'Ready to pay' when 'hot' then 'Hot' when 'interested' then 'Interested'
                when 'approval' then 'Needs approval' when 'price' then 'Price concern' when 'later' then 'Later' end,
      'outcome', case when h.ocat = 'positive' or h.ocode ~ 'call_back|call_later' then h.olabel end,
      'reg', greatest(h.reg, coalesce(h.reg_count, 0)), 'att', h.att, 'watch', round(h.watch), 'best', round(h.best), 'best_at', h.best_at,
      'last_at', h.last_at, 'last_min', round(h.last_min), 'last_pitch', h.last_pitch,
      'pitch', h.pitch, 'chats', h.chats, 'polls', h.polls,
      'talk', h.talk, 'talk_by', coalesce(h.by_user, '[]'),
      'calls', coalesce(h.call_count, 0), 'wa', coalesce(h.wa_count, 0), 'last_talk', h.last_talk, 'next', h.next_follow_up_at)
      order by case h.cat when 9 then 1.5 else h.cat end, h.watch desc, h.talk desc, (h.chats + h.polls + case when h.pitch then 1 else 0 end) desc, h.id)
    from (select * from hot order by case cat when 9 then 1.5 else cat end, watch desc, talk desc, (chats + polls + case when pitch then 1 else 0 end) desc, id
          limit coalesce(p_limit, 5000)) h), '[]'))
$function$;

-- Leads in each group of a webinar (same row shape as batch_leads_list for the lead lists).
create or replace function public.batch_link_leads(p_batch uuid, p_group text)
returns table(lead_id uuid, rep uuid, name text, phone text, registered boolean, watch_minutes numeric, attempts int, max_dur int, last_outcome_id uuid, est boolean)
language sql stable security definer set search_path = '' as $$
  with b as (select id, org_id, webinar_at, pitch_minute, coalesce(started_at, webinar_at) + make_interval(mins => coalesce(pitch_minute, 0)) link_at,
                    coalesce(started_at, webinar_at) st from public.batches where id = p_batch),
  x as (
    select bl.lead_id, l.assigned_to rep, coalesce(nullif(l.name, ''), l.phone) name, l.phone, bl.registered, bl.watch_minutes, bl.saw_pitch, bl.pitch_est,
      (select min((s->>'join')::timestamptz) from jsonb_array_elements(bl.sessions) s) first_join,
      (select max((s->>'leave')::timestamptz) from jsonb_array_elements(bl.sessions) s) last_leave,
      (select count(*) from public.calls c where c.lead_id = bl.lead_id and c.started_at > (select st from b) and c.direction = 'outgoing')::int attempts,
      (select coalesce(max(c.duration_sec), 0) from public.calls c where c.lead_id = bl.lead_id and c.started_at > (select st from b))::int max_dur,
      exists (select 1 from public.sales s where s.lead_id = bl.lead_id and s.status = 'verified' and s.sold_at >= (select st from b)) or coalesce(l.won_at >= (select st from b), false) bought,
      l.last_outcome_id
    from public.batch_leads bl join public.leads l on l.id = bl.lead_id and l.deleted_at is null
    where bl.batch_id = p_batch and (public.is_org_admin((select org_id from b)) or public.lead_visible(bl.lead_id))
  )
  select x.lead_id, x.rep, x.name, x.phone, x.registered, x.watch_minutes, x.attempts, x.max_dur, x.last_outcome_id, x.pitch_est
  from x, b where case p_group
    when 'present' then coalesce(x.saw_pitch, false)
    when 'present_not_called' then coalesce(x.saw_pitch, false) and x.attempts = 0 and not x.bought
    when 'present_called' then coalesce(x.saw_pitch, false) and x.attempts > 0
    when 'present_talked' then coalesce(x.saw_pitch, false) and x.max_dur > 30
    when 'present_bought' then coalesce(x.saw_pitch, false) and x.bought
    when 'present_not_bought' then coalesce(x.saw_pitch, false) and not x.bought
    when 'left_before' then coalesce(x.watch_minutes, 0) > 0 and not coalesce(x.saw_pitch, false)
                           and (x.last_leave < b.link_at or (x.last_leave is null and x.watch_minutes < b.pitch_minute))
    when 'joined_after' then coalesce(x.watch_minutes, 0) > 0 and not coalesce(x.saw_pitch, false) and x.first_join > b.link_at
    when 'partly' then coalesce(x.watch_minutes, 0) > 0 and not coalesce(x.saw_pitch, false) and x.first_join <= b.link_at and x.last_leave >= b.link_at
    else false end
  order by x.watch_minutes desc nulls last, x.name
$$;
revoke all on function public.batch_link_leads(uuid, text) from public, anon;
grant execute on function public.batch_link_leads(uuid, text) to authenticated;

-- Counts for the "Payment link dropped" card + people in the room minute by minute + a link found in the chat.
create or replace function public.batch_link_report(p_batch uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b record; v jsonb := '{}'; g text; st timestamptz;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null or not public.is_org_member(b.org_id) then raise exception 'Webinar not found'; end if;
  st := coalesce(b.started_at, b.webinar_at);
  foreach g in array array['present','present_not_called','present_called','present_talked','present_bought','present_not_bought','left_before','joined_after','partly'] loop
    v := v || jsonb_build_object(g, (select count(*) from public.batch_link_leads(p_batch, g)));
  end loop;
  return jsonb_build_object(
    'minute', b.pitch_minute, 'pay_link', b.pay_link, 'started_at', st, 'counts', v,
    'attended', (select count(*) from public.batch_leads where batch_id = p_batch and coalesce(watch_minutes, 0) > 0),
    'estimated', (select count(*) from public.batch_leads where batch_id = p_batch and pitch_est),
    'has_sessions', exists (select 1 from public.batch_leads where batch_id = p_batch and jsonb_array_length(coalesce(sessions, '[]')) > 0),
    -- people in the room for each minute of the webinar (from join / leave times)
    'curve', (select coalesce(jsonb_agg(n order by m), '[]') from (
        select m, count(distinct bl.lead_id) n
        from generate_series(0, coalesce((select ceil(extract(epoch from max((s->>'leave')::timestamptz) - st) / 60)::int
                 from public.batch_leads bl2, jsonb_array_elements(bl2.sessions) s where bl2.batch_id = p_batch), -1)) m
        left join public.batch_leads bl on bl.batch_id = p_batch and exists (select 1 from jsonb_array_elements(bl.sessions) s
             where (s->>'join')::timestamptz <= st + make_interval(mins => m) and (s->>'leave')::timestamptz > st + make_interval(mins => m))
        group by m) q),
    -- first payment / landing-page link posted in the chat
    'chat_link', (select jsonb_build_object('minute', c.minute, 'at', c.sent_at, 'sender', c.sender, 'message', left(c.message, 200))
       from public.batch_chat c where c.batch_id = p_batch
         and c.message ~* '(razorpay|rzp\.io|instamojo|imjo\.in|cashfree|payu|paytm|phonepe|upi://|pages\.razorpay|stripe|paypal|ccavenue|easebuzz|graphy|tagmango|exly|cosmofeed|superprofile|flexifunnels|checkout|payment|pay\.|/pay|https?://)'
       order by (c.message ~* '(razorpay|rzp\.io|instamojo|imjo\.in|cashfree|payu|paytm|phonepe|upi://|stripe|paypal|ccavenue|easebuzz|checkout|payment)') desc, c.minute nulls last, c.sent_at limit 1));
end $$;
revoke all on function public.batch_link_report(uuid) from public, anon;
grant execute on function public.batch_link_report(uuid) to authenticated;

-- WhatsApp follow-up starts by itself for people who saw the payment link (sequences with "Start for people who saw the payment link").
create or replace function public.t_bl_link_seq() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record; v_user uuid; v_org uuid;
begin
  if coalesce(new.saw_pitch, false) and not coalesce(old.saw_pitch, false) then
    select assigned_to, org_id into v_user, v_org from public.leads where id = new.lead_id and deleted_at is null and won_at is null;
    if v_user is null then return new; end if;
    for s in select id from public.wa_sequences where org_id = v_org and auto_link and not is_archived and (owner_id is null or owner_id = v_user) loop
      if exists (select 1 from public.wa_sequence_leads e where e.sequence_id = s.id and e.lead_id = new.lead_id and e.batch_id = new.batch_id) then continue; end if;
      begin perform public.seq_enroll(s.id, new.lead_id, v_user, new.batch_id, 'link'); exception when others then null; end;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists t_bl_link_seq on public.batch_leads;
create trigger t_bl_link_seq after update of saw_pitch on public.batch_leads for each row execute function public.t_bl_link_seq();

-- Re-count every webinar that has a link minute with the new 10-minute rule.
do $$ declare r record; begin
  for r in select id from public.batches where pitch_minute is not null loop perform public.batch_recompute(r.id); end loop;
end $$;
