-- Recording paths for a set of calls (call id → storage path), for ▶ buttons on any call list.
create or replace function public.call_recording_paths(p_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.id, c.recording_path), '{}'::jsonb) from public.calls c
  where c.id = any(p_ids) and c.recording_path is not null and c.recording_status::text not in ('expired', 'missing')
    and (c.user_id = auth.uid() or public.can_see_user(c.org_id, c.user_id))
$$;
-- lead_path calls also carry the path.
create or replace function public.lead_path(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  return jsonb_build_object('effort', public.lead_effort(p_lead),
    'calls', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'started_at', c.started_at, 'direction', c.direction,
        'duration_sec', c.duration_sec, 'outcome', o.label, 'category', o.category, 'by', coalesce(p.full_name, p.email),
        'recording_path', case when c.recording_status::text not in ('expired', 'missing') then c.recording_path end, 'notes', c.notes) order by c.started_at desc), '[]')
      from public.calls c left join public.call_outcomes o on o.id = c.outcome_id left join public.profiles p on p.id = c.user_id where c.lead_id = p_lead),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('template_name', w.template_name, 'sent_at', w.sent_at, 'by', coalesce(p.full_name, p.email)) order by w.sent_at desc), '[]')
      from public.wa_messages w left join public.profiles p on p.id = w.user_id where w.lead_id = p_lead and w.undone_at is null));
end $$;
