-- Sequence messages can use the webinar's joining link and payment link.
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
          select jsonb_agg(jsonb_build_object('batch_id', b.id, 'batch', jsonb_build_object('name', b.name, 'webinar_at', b.webinar_at, 'join_link', b.join_link, 'pay_link', b.pay_link)))
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
end $function$;
