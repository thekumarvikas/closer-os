-- Second webinar link: reserve-a-seat (token) payment link, fill-in {{tokenLink}}.
alter table public.batches add column if not exists token_link text;
CREATE OR REPLACE FUNCTION public.my_sequence_due(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_end timestamptz; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_end := ((now() at time zone v_tz)::date + 1)::timestamp at time zone v_tz;
  select jsonb_build_object(
    'due', coalesce((select jsonb_agg(r order by r->>'due_at') from (
      select jsonb_build_object('id', e.id, 'kind', 'sequence', 'sequence_id', s.id, 'sequence', s.name, 'position', m.position,
        'total', (select count(*) from public.wa_sequence_messages x where x.sequence_id = s.id),
        'due_at', e.next_due_at, 'body', m.body, 'media_path', m.media_path, 'media_type', m.media_type, 'media_name', m.media_name,
        'lead', to_jsonb(l) || jsonb_build_object('batch_leads', coalesce((
          select jsonb_agg(jsonb_build_object('batch_id', b.id, 'batch', jsonb_build_object('name', b.name, 'webinar_at', b.webinar_at, 'join_link', b.join_link, 'pay_link', b.pay_link, 'token_link', b.token_link)))
          from public.batches b where b.id = e.batch_id), '[]'))) r
      from public.wa_sequence_leads e
      join public.wa_sequences s on s.id = e.sequence_id
      join public.wa_sequence_messages m on m.sequence_id = e.sequence_id and m.position = e.next_pos
      join public.leads l on l.id = e.lead_id
      where e.org_id = p_org and e.user_id = auth.uid() and e.status = 'active' and e.next_due_at <= now()
      union all
      select jsonb_build_object('id', w.id, 'kind', 'scheduled', 'sequence_id', null, 'sequence', 'Scheduled message', 'position', 1, 'total', 1,
        'due_at', w.due_at, 'body', w.body, 'media_path', w.media_path, 'media_type', w.media_type, 'media_name', w.media_name,
        'lead', to_jsonb(l) || jsonb_build_object('batch_leads', '[]'::jsonb))
      from public.wa_scheduled w join public.leads l on l.id = w.lead_id
      where w.org_id = p_org and w.user_id = auth.uid() and w.status = 'pending' and w.due_at <= now()
      limit 500) q), '[]'),
    'later_today', (select count(*) from public.wa_sequence_leads e where e.org_id = p_org and e.user_id = auth.uid()
      and e.status = 'active' and e.next_due_at > now() and e.next_due_at < v_end)
      + (select count(*) from public.wa_scheduled w where w.org_id = p_org and w.user_id = auth.uid() and w.status = 'pending'
      and w.due_at > now() and w.due_at < v_end)
  ) into res;
  return res;
end $function$
;
CREATE OR REPLACE FUNCTION public.batch_link_report(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b record; v jsonb := '{}'; g text; st timestamptz;
begin
  select * into b from public.batches where id = p_batch;
  if b.id is null or not public.is_org_member(b.org_id) then raise exception 'Webinar not found'; end if;
  st := coalesce(b.started_at, b.webinar_at);
  foreach g in array array['present','present_not_called','present_called','present_talked','present_bought','present_not_bought','left_before','joined_after','partly'] loop
    v := v || jsonb_build_object(g, (select count(*) from public.batch_link_leads(p_batch, g)));
  end loop;
  return jsonb_build_object(
    'minute', b.pitch_minute, 'pay_link', b.pay_link, 'token_link', b.token_link, 'started_at', st, 'counts', v,
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
end $function$
;
