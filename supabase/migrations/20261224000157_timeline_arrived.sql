-- Buyer journey: payments / orders carry the time they reached Closer OS (used when the sheet gives only a date).
CREATE OR REPLACE FUNCTION public.buyer_timeline(p_sale uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not (public.is_org_manager(s.org_id) or s.credited_to = auth.uid() or s.claimed_by = auth.uid()) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(e order by e->>'at') from (
    select jsonb_build_object('at', coalesce(l.signup_at, l.created_at), 'kind', 'arrived', 'text', 'Signed up' || coalesce(' · ' || nullif(concat_ws(' · ', l.source, l.campaign), ''), '')) e
      from public.leads l where l.id = s.lead_id
    union all
    select jsonb_build_object('at', o.at, 'kind', 'arrived', 'text', 'Came in again' || coalesce(' · ' || nullif(concat_ws(' · ', o.source, o.campaign), ''), ''))
      from public.lead_origins o where o.lead_id = s.lead_id and not o.is_first
    union all
    select jsonb_build_object('at', c.started_at, 'kind', 'call', 'user_id', c.user_id, 'direction', c.direction, 'duration_sec', c.duration_sec,
      'text', coalesce(oc.label, ''), 'note', c.notes, 'id', c.id, 'recording_path', c.recording_path, 'recording_status', c.recording_status)
      from public.calls c left join public.call_outcomes oc on oc.id = c.outcome_id where c.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', w.sent_at, 'kind', 'whatsapp', 'user_id', w.user_id, 'text', coalesce(w.template_name, 'WhatsApp message'))
      from public.wa_messages w where w.lead_id = s.lead_id and w.undone_at is null
    union all
    select jsonb_build_object('at', b.webinar_at, 'kind', 'webinar', 'text', b.name || ': ' || case when bl.watch_minutes is null then 'registered (no attendance data)'
      when bl.watch_minutes > 0 then 'watched ' || bl.watch_minutes || ' min' || case when bl.saw_pitch then ' · saw the pitch' else '' end
        || case when coalesce(bl.chat_count, 0) > 0 then ' · ' || bl.chat_count || ' chat message' || case when bl.chat_count = 1 then '' else 's' end else '' end
        || case when coalesce(bl.poll_answered, 0) > 0 then ' · answered ' || bl.poll_answered || ' poll' || case when bl.poll_answered = 1 then '' else 's' end else '' end
      else 'registered, didn''t join' end)
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', bc.sent_at, 'kind', 'chat', 'text', '"' || left(bc.message, 200) || '"')
      from public.batch_chat bc where bc.lead_id = s.lead_id and bc.sent_at is not null
    union all
    select jsonb_build_object('at', f.due_at, 'kind', 'followup', 'user_id', f.assigned_to, 'text', 'Follow-up planned' || case when f.dialled_at is not null then ' · called' when f.status = 'cancelled' then ' · cancelled' else '' end)
      from public.follow_ups f where f.lead_id = s.lead_id
    union all
    select jsonb_build_object('at', a.created_at, 'kind', 'note', 'user_id', a.user_id, 'text', a.data->>'text') from public.lead_activities a where a.lead_id = s.lead_id and a.kind = 'note'
    union all
    select jsonb_build_object('at', x.sold_at, 'arrived', x.created_at, 'kind', 'sale', 'text', coalesce(x.product, 'Sale') || ' · order value ' || x.amount || coalesce(' · ' || x.enrol_batch, ''))
      from public.sales x where (x.id = s.id or (s.lead_id is not null and x.lead_id = s.lead_id)) and x.status <> 'rejected'
    union all
    select jsonb_build_object('at', pm.paid_at, 'arrived', pm.created_at, 'kind', pm.kind, 'text', pm.amount || ' · ' || pm.method || coalesce(' · ' || pm.part_full, '') || coalesce(' · ' || pm.reference, ''))
      from public.sale_payments pm join public.sales x on x.id = pm.sale_id where x.id = s.id or (s.lead_id is not null and x.lead_id = s.lead_id)
  ) t where e->>'at' is not null), '[]'::jsonb);
end $function$

;
