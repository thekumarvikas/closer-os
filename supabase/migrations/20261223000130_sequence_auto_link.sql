-- WhatsApp sequence that starts by itself for people present when the payment link was dropped.
CREATE OR REPLACE FUNCTION public.save_sequence(p_org uuid, p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_company boolean := coalesce((p->>'company')::boolean, false);
  s record; x jsonb; i int := 0; v_n int; e record;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_n := jsonb_array_length(coalesce(p->'messages', '[]'));
  if v_n = 0 then raise exception 'Add at least one message'; end if;
  if v_n > 50 then raise exception 'A sequence can have up to 50 messages'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Give the sequence a name'; end if;
  if v_id is not null then
    select * into s from public.wa_sequences where id = v_id and org_id = p_org;
    if s is null then raise exception 'Sequence not found'; end if;
    if s.owner_id is null and not public.is_org_manager(p_org) then raise exception 'Only managers can change company sequences'; end if;
    if s.owner_id is not null and s.owner_id <> auth.uid() then raise exception 'This is someone else''s sequence'; end if;
    update public.wa_sequences set name = trim(p->>'name'),
      start_outcomes = coalesce(array(select jsonb_array_elements_text(p->'start_outcomes')::uuid), '{}'),
      auto_webinar = case when p ? 'auto_webinar' then coalesce((p->>'auto_webinar')::boolean, false) else auto_webinar end,
      auto_link = case when p ? 'auto_link' then coalesce((p->>'auto_link')::boolean, false) else auto_link end, updated_at = now()
    where id = v_id;
    delete from public.wa_sequence_messages where sequence_id = v_id;
  else
    if v_company and not public.is_org_manager(p_org) then raise exception 'Only managers can make company sequences'; end if;
    insert into public.wa_sequences (org_id, owner_id, name, start_outcomes, auto_webinar, auto_link)
    values (p_org, case when v_company then null else auth.uid() end, trim(p->>'name'),
      coalesce(array(select jsonb_array_elements_text(p->'start_outcomes')::uuid), '{}'), coalesce((p->>'auto_webinar')::boolean, false), coalesce((p->>'auto_link')::boolean, false))
    returning id into v_id;
  end if;
  for x in select * from jsonb_array_elements(p->'messages') loop
    i := i + 1;
    if coalesce(trim(x->>'body'), '') = '' and coalesce(x->>'media_path', '') = '' then raise exception 'Message % is empty', i; end if;
    insert into public.wa_sequence_messages (sequence_id, org_id, position, anchor, day_offset, send_time, minutes_before, body, media_path, media_type, media_name)
    values (v_id, p_org, i, coalesce(nullif(x->>'anchor', ''), 'start'), least(greatest(coalesce((x->>'day_offset')::int, 0), 0), 365),
      coalesce(nullif(x->>'send_time', '')::time, '10:00'), (x->>'minutes_before')::int, coalesce(x->>'body', ''),
      nullif(x->>'media_path', ''), nullif(x->>'media_type', ''), nullif(x->>'media_name', ''));
  end loop;
  for e in select id, next_pos from public.wa_sequence_leads where sequence_id = v_id and status in ('active', 'paused') loop
    perform public.seq_advance(e.id, coalesce(e.next_pos, 1));
  end loop;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.sequences(p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'owner_id', s.owner_id, 'company', s.owner_id is null, 'mine', s.owner_id = auth.uid(),
    'owner_name', (select full_name from public.profiles p where p.id = s.owner_id),
    'start_outcomes', to_jsonb(s.start_outcomes), 'auto_webinar', s.auto_webinar, 'auto_link', s.auto_link, 'updated_at', s.updated_at,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'position', m.position, 'anchor', m.anchor, 'day_offset', m.day_offset,
        'send_time', to_char(m.send_time, 'HH24:MI'), 'minutes_before', m.minutes_before, 'body', m.body,
        'media_path', m.media_path, 'media_type', m.media_type, 'media_name', m.media_name) order by m.position)
      from public.wa_sequence_messages m where m.sequence_id = s.id), '[]'),
    'active_mine', (select count(*) from public.wa_sequence_leads e where e.sequence_id = s.id and e.status = 'active' and e.user_id = auth.uid()),
    'active_all', (select count(*) from public.wa_sequence_leads e where e.sequence_id = s.id and e.status = 'active'),
    'done_all', (select count(*) from public.wa_sequence_leads e where e.sequence_id = s.id and e.status = 'done')
  ) order by s.owner_id is not null, s.name), '[]')
  from public.wa_sequences s
  where s.org_id = p_org and not s.is_archived and public.is_org_member(p_org)
    and (s.owner_id is null or s.owner_id = auth.uid() or public.can_see_user(p_org, s.owner_id))
$function$;
