-- Richer notes: a lead's "key facts" (always shown at the top), notes without a call, quick note tags
-- (company list in organizations.settings.note_tags) and one notes timeline per lead.
alter table public.leads add column if not exists key_facts text;
alter table public.leads add column if not exists key_facts_at timestamptz;
alter table public.calls add column if not exists note_tags text[];

create or replace function public.set_key_facts(p_lead uuid, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  update public.leads set key_facts = nullif(trim(p_text), ''), key_facts_at = now() where id = p_lead;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  select org_id, id, auth.uid(), 'key_facts', jsonb_build_object('text', nullif(trim(p_text), '')) from public.leads where id = p_lead;
end $$;

create or replace function public.add_lead_note(p_lead uuid, p_text text, p_tags text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  if coalesce(trim(p_text), '') = '' and coalesce(cardinality(p_tags), 0) = 0 then raise exception 'Write a note first'; end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  select org_id, id, auth.uid(), 'note', jsonb_build_object('text', nullif(trim(p_text), ''), 'tags', coalesce(to_jsonb(p_tags), '[]'::jsonb))
  from public.leads where id = p_lead;
end $$;

-- Every note on a lead, newest first: call notes (with outcome + tags) and notes added without a call.
create or replace function public.lead_notes(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('kind', 'call', 'at', c.started_at, 'user_id', c.user_id, 'text', c.notes,
      'tags', coalesce(to_jsonb(c.note_tags), c.outcome_data->'note_tags', '[]'::jsonb), 'outcome', o.label, 'direction', c.direction, 'duration_sec', c.duration_sec,
      'purpose', c.purpose, 'by', p.full_name) as x
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id left join public.profiles p on p.id = c.user_id
    where c.lead_id = p_lead and (coalesce(c.notes, '') <> '' or coalesce(cardinality(c.note_tags), 0) > 0
      or jsonb_array_length(coalesce(c.outcome_data->'note_tags', '[]'::jsonb)) > 0)
    union all
    select jsonb_build_object('kind', 'note', 'at', a.created_at, 'user_id', a.user_id, 'text', a.data->>'text',
      'tags', coalesce(a.data->'tags', '[]'::jsonb), 'by', p.full_name)
    from public.lead_activities a left join public.profiles p on p.id = a.user_id
    where a.lead_id = p_lead and a.kind = 'note'
  ) t;
  return res;
end $$;

-- log_call also stores note tags.
create or replace function public.set_call_note_tags(p_call uuid, p_tags text[])
returns void language sql security definer set search_path = '' as $$
  update public.calls set note_tags = p_tags where id = p_call and user_id = auth.uid();
$$;

-- Default quick tags for every company (managers edit them in Settings).
update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('note_tags', jsonb_build_array(
  'Price objection', 'Wants EMI', 'Needs to ask family', 'Decision maker: spouse', 'Busy — call in evening',
  'Asked for details on WhatsApp', 'Comparing with others', 'Very interested', 'Already bought elsewhere', 'Language: Hindi'))
where not (coalesce(settings, '{}'::jsonb) ? 'note_tags');

revoke execute on function public.set_key_facts(uuid, text) from anon, public;
revoke execute on function public.add_lead_note(uuid, text, text[]) from anon, public;
revoke execute on function public.lead_notes(uuid) from anon, public;
revoke execute on function public.set_call_note_tags(uuid, text[]) from anon, public;
grant execute on function public.set_key_facts(uuid, text) to authenticated;
grant execute on function public.add_lead_note(uuid, text, text[]) to authenticated;
grant execute on function public.lead_notes(uuid) to authenticated;
grant execute on function public.set_call_note_tags(uuid, text[]) to authenticated;
