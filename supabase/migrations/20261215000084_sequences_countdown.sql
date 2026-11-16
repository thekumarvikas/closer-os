-- WhatsApp sequences: a countdown to the webinar that starts by itself when someone registers, and
-- late joiners only get the messages that are still ahead of them.
alter table public.wa_sequences add column if not exists auto_webinar boolean not null default false;   -- start when a lead joins a webinar

-- Next message of an enrollment. "Around the event" messages whose moment passed before the lead joined are skipped.
create or replace function public.seq_advance(p_enroll uuid, p_from int)
returns void language plpgsql security definer set search_path = '' as $$
declare e record; m record; v_due timestamptz;
begin
  select * into e from public.wa_sequence_leads where id = p_enroll;
  if e is null then return; end if;
  for m in select * from public.wa_sequence_messages where sequence_id = e.sequence_id and position >= p_from order by position loop
    v_due := public.seq_message_due(p_enroll, m.id);
    if v_due is null then continue; end if;
    if m.anchor = 'event' and (v_due < e.started_at or v_due < now() - interval '12 hours') then continue; end if;
    update public.wa_sequence_leads set next_pos = m.position, next_due_at = v_due, updated_at = now() where id = p_enroll;
    return;
  end loop;
  update public.wa_sequence_leads set next_pos = null, next_due_at = null,
    status = case when status in ('active', 'paused') then 'done' else status end, updated_at = now() where id = p_enroll;
end $$;

create or replace function public.save_sequence(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
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
      auto_webinar = case when p ? 'auto_webinar' then coalesce((p->>'auto_webinar')::boolean, false) else auto_webinar end, updated_at = now()
    where id = v_id;
    delete from public.wa_sequence_messages where sequence_id = v_id;
  else
    if v_company and not public.is_org_manager(p_org) then raise exception 'Only managers can make company sequences'; end if;
    insert into public.wa_sequences (org_id, owner_id, name, start_outcomes, auto_webinar)
    values (p_org, case when v_company then null else auth.uid() end, trim(p->>'name'),
      coalesce(array(select jsonb_array_elements_text(p->'start_outcomes')::uuid), '{}'), coalesce((p->>'auto_webinar')::boolean, false))
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
end $$;

create or replace function public.sequences(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'owner_id', s.owner_id, 'company', s.owner_id is null, 'mine', s.owner_id = auth.uid(),
    'owner_name', (select full_name from public.profiles p where p.id = s.owner_id),
    'start_outcomes', to_jsonb(s.start_outcomes), 'auto_webinar', s.auto_webinar, 'updated_at', s.updated_at,
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
$$;

-- A lead joins an upcoming webinar (or gets its caller afterwards): the countdown sequences start for it.
-- The sender is the reminder caller, else the lead's owner; a personal sequence only starts for its owner's leads.
create or replace function public.seq_auto_webinar(p_lead uuid, p_batch uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b record; l record; bl record; s record; v_user uuid;
begin
  select id, org_id, webinar_at, is_archived into b from public.batches where id = p_batch;
  if b.id is null or b.is_archived or b.webinar_at < now() then return; end if;
  select assigned_to into l from public.leads where id = p_lead and deleted_at is null;
  select reminder_by, is_holdout into bl from public.batch_leads where batch_id = p_batch and lead_id = p_lead;
  if not found or coalesce(bl.is_holdout, false) then return; end if;
  v_user := coalesce(bl.reminder_by, l.assigned_to);
  if v_user is null then return; end if;
  for s in select id, owner_id from public.wa_sequences where org_id = b.org_id and auto_webinar and not is_archived
      and (owner_id is null or owner_id = v_user) loop
    -- one countdown per webinar for a lead
    if exists (select 1 from public.wa_sequence_leads e where e.sequence_id = s.id and e.lead_id = p_lead and e.batch_id = p_batch) then continue; end if;
    perform public.seq_enroll(s.id, p_lead, v_user, p_batch, 'webinar');
  end loop;
exception when others then null;   -- never block a registration
end $$;

create or replace function public.t_seq_webinar_join() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.wa_sequences where org_id = new.org_id and auto_webinar and not is_archived) then
    perform public.seq_auto_webinar(new.lead_id, new.batch_id);
  end if;
  return new;
end $$;
drop trigger if exists t_seq_webinar_join on public.batch_leads;
create trigger t_seq_webinar_join after insert or update of reminder_by on public.batch_leads for each row execute function public.t_seq_webinar_join();

create or replace function public.t_seq_lead_assigned() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to
     and exists (select 1 from public.wa_sequences where org_id = new.org_id and auto_webinar and not is_archived) then
    for r in select bl.batch_id from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = new.id and b.webinar_at > now() loop
      perform public.seq_auto_webinar(new.id, r.batch_id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists t_seq_lead_assigned on public.leads;
create trigger t_seq_lead_assigned after update of assigned_to on public.leads for each row execute function public.t_seq_lead_assigned();

revoke execute on function public.seq_auto_webinar(uuid, uuid) from anon, public, authenticated;
revoke execute on function public.t_seq_webinar_join() from anon, public, authenticated;
revoke execute on function public.t_seq_lead_assigned() from anon, public, authenticated;
