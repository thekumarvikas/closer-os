-- Smarter notes (Nov 2026):
--  * lead profile (challenges, goals, budget) on leads.profile
--  * pinned notes (max 3) on leads.pinned
--  * the latest note on the lead itself (leads.last_note) — for the before-call brief and follow-up reminders, also offline
--  * objections with several answers (playbook_items kind 'objection' + kind 'answer' with parent_id);
--    a rep's new objection / answer is theirs at once and reaches the team after a manager approves (existing playbook rule)
--  * objections raised in a call: calls.outcome_data.objections = [{"id": objection, "answer": answer|null}]
--    → leads.objections (newest first) + usage numbers per objection and answer.

-- ───── Lead profile, pinned notes, latest note, objections raised ─────
alter table public.leads add column if not exists profile jsonb not null default '{}'::jsonb;
alter table public.leads add column if not exists pinned jsonb not null default '[]'::jsonb;
alter table public.leads add column if not exists last_note text;
alter table public.leads add column if not exists last_note_at timestamptz;
alter table public.leads add column if not exists objections uuid[] not null default '{}';

-- Saves part of a lead's profile. Keys: challenges (text[]), challenges_text, goals (text[]), goals_text, budget, budget_amount,
-- plus profession / city (stored on the lead's own columns). null or "" removes a key.
create or replace function public.set_lead_profile(p_lead uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k text; v jsonb; prof jsonb;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select profile into prof from public.leads where id = p_lead;
  prof := coalesce(prof, '{}'::jsonb);
  for k, v in select * from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    if k in ('challenges', 'goals') then
      if jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0 then prof := prof || jsonb_build_object(k, v); else prof := prof - k; end if;
    elsif k in ('challenges_text', 'goals_text', 'budget', 'budget_amount') then
      if v is null or jsonb_typeof(v) = 'null' or coalesce(trim(v #>> '{}'), '') = '' then prof := prof - k;
      else prof := prof || jsonb_build_object(k, left(trim(v #>> '{}'), 500)); end if;
    end if;
  end loop;
  update public.leads set profile = prof,
    profession = case when p ? 'profession' then nullif(trim(p->>'profession'), '') else profession end,
    city = case when p ? 'city' then nullif(trim(p->>'city'), '') else city end,
    updated_at = now()
  where id = p_lead;
  return prof;
end $$;

-- Pins (or unpins) a note on a lead. p_ref = the note's id (call id or note id); text is kept as it was. Max 3 pins.
create or replace function public.pin_lead_note(p_lead uuid, p_ref text, p_text text, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cur jsonb; who text;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select pinned into cur from public.leads where id = p_lead;
  cur := coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(cur, '[]'::jsonb)) e where e->>'ref' is distinct from p_ref), '[]'::jsonb);
  if p_on then
    if coalesce(trim(p_text), '') = '' then raise exception 'Nothing to pin'; end if;
    if jsonb_array_length(cur) >= 3 then raise exception 'Up to 3 pinned notes — unpin one first'; end if;
    select full_name into who from public.profiles where id = auth.uid();
    cur := jsonb_build_array(jsonb_build_object('ref', p_ref, 'text', left(trim(p_text), 1000), 'by', who, 'at', now())) || cur;
  end if;
  update public.leads set pinned = cur, updated_at = now() where id = p_lead;
  return cur;
end $$;

-- The latest note on the lead (call notes and notes without a call).
create or replace function public.t_call_last_note() returns trigger language plpgsql security definer set search_path = '' as $$
declare ids uuid[];
begin
  if new.lead_id is null then return new; end if;
  if coalesce(trim(new.notes), '') <> '' and (tg_op = 'INSERT' or new.notes is distinct from old.notes) then
    update public.leads set last_note = left(trim(new.notes), 1000), last_note_at = new.started_at
    where id = new.lead_id and (last_note_at is null or last_note_at <= new.started_at);
  end if;
  -- Objections raised in this call → the lead's list, newest first (max 5).
  if jsonb_typeof(new.outcome_data->'objections') = 'array' and jsonb_array_length(new.outcome_data->'objections') > 0
     and (tg_op = 'INSERT' or new.outcome_data->'objections' is distinct from old.outcome_data->'objections') then
    select array_agg((e->>'id')::uuid) into ids from jsonb_array_elements(new.outcome_data->'objections') e
      where (e->>'id') ~ '^[0-9a-f-]{36}$';
    if ids is not null then
      update public.leads l set objections = (coalesce((select array_agg(x order by ord) from (
          select x, min(ord) ord from unnest(ids || l.objections) with ordinality u(x, ord) group by x) s), '{}'::uuid[]))[1:5]
      where l.id = new.lead_id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_call_last_note on public.calls;
create trigger t_call_last_note after insert or update of notes, outcome_data, lead_id on public.calls
  for each row execute function public.t_call_last_note();

create or replace function public.t_note_last_note() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'note' and coalesce(trim(new.data->>'text'), '') <> '' then
    update public.leads set last_note = left(trim(new.data->>'text'), 1000), last_note_at = new.created_at
    where id = new.lead_id and (last_note_at is null or last_note_at <= new.created_at);
  end if;
  return new;
end $$;
drop trigger if exists t_note_last_note on public.lead_activities;
create trigger t_note_last_note after insert on public.lead_activities for each row execute function public.t_note_last_note();

-- Fill the latest note for existing leads.
update public.leads l set last_note = s.txt, last_note_at = s.at
from (
  select distinct on (lead_id) lead_id, txt, at from (
    select lead_id, left(trim(notes), 1000) txt, started_at at from public.calls where lead_id is not null and coalesce(trim(notes), '') <> ''
    union all
    select lead_id, left(trim(data->>'text'), 1000), created_at from public.lead_activities where kind = 'note' and coalesce(trim(data->>'text'), '') <> ''
  ) u order by lead_id, at desc
) s where s.lead_id = l.id and l.last_note is null;

-- Notes timeline now carries each note's id (for pinning).
create or replace function public.lead_notes(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('id', c.id, 'kind', 'call', 'at', c.started_at, 'user_id', c.user_id, 'text', c.notes,
      'tags', coalesce(to_jsonb(c.note_tags), c.outcome_data->'note_tags', '[]'::jsonb), 'outcome', o.label, 'direction', c.direction, 'duration_sec', c.duration_sec,
      'purpose', c.purpose, 'by', p.full_name,
      'objections', (select jsonb_agg(pi.title) from jsonb_array_elements(coalesce(c.outcome_data->'objections', '[]'::jsonb)) e
                     join public.playbook_items pi on pi.id::text = e->>'id')) as x
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id left join public.profiles p on p.id = c.user_id
    where c.lead_id = p_lead and (coalesce(c.notes, '') <> '' or coalesce(cardinality(c.note_tags), 0) > 0
      or jsonb_array_length(coalesce(c.outcome_data->'note_tags', '[]'::jsonb)) > 0
      or jsonb_array_length(coalesce(c.outcome_data->'objections', '[]'::jsonb)) > 0)
    union all
    select jsonb_build_object('id', a.id, 'kind', 'note', 'at', a.created_at, 'user_id', a.user_id, 'text', a.data->>'text',
      'tags', coalesce(a.data->'tags', '[]'::jsonb), 'by', p.full_name)
    from public.lead_activities a left join public.profiles p on p.id = a.user_id
    where a.lead_id = p_lead and a.kind = 'note'
  ) t;
  return res;
end $$;

-- ───── Objections with several answers ─────
alter table public.playbook_items add column if not exists parent_id uuid references public.playbook_items(id) on delete cascade;
alter table public.playbook_items drop constraint if exists playbook_items_kind_check;
alter table public.playbook_items add constraint playbook_items_kind_check check (kind in ('script', 'objection', 'answer', 'link', 'doc'));
create index if not exists playbook_parent_idx on public.playbook_items (parent_id) where parent_id is not null;

-- Adds (or edits my own pending / any as manager) an objection, optionally with a first answer, or an extra answer to an objection.
-- Managers and individual accounts: published at once. Reps: pending → only they see it until a manager approves.
create or replace function public.save_objection(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare mgr boolean := public.is_org_manager(p_org); st text; v_id uuid := nullif(p->>'id', '')::uuid; v_parent uuid := nullif(p->>'parent_id', '')::uuid;
  v_kind text := case when v_parent is null then 'objection' else 'answer' end; v_title text; v_body text := nullif(trim(p->>'body'), '');
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member'; end if;
  st := case when mgr then 'published' else 'pending' end;
  if v_kind = 'objection' then
    v_title := nullif(trim(p->>'title'), '');
    if v_title is null then raise exception 'Write the objection first'; end if;
  else
    if v_body is null then raise exception 'Write the answer first'; end if;
    if not exists (select 1 from public.playbook_items where id = v_parent and org_id = p_org and kind = 'objection'
                   and (status = 'published' or created_by = auth.uid() or mgr)) then raise exception 'Objection not found'; end if;
    v_title := 'Answer';
  end if;
  if v_id is not null then
    update public.playbook_items set title = coalesce(v_title, title), body = case when p ? 'body' then v_body else body end,
      section = case when p ? 'section' then nullif(trim(p->>'section'), '') else section end, updated_at = now()
    where id = v_id and org_id = p_org and (mgr or (created_by = auth.uid() and status = 'pending'));
    if not found then raise exception 'Only managers can change approved items'; end if;
    return v_id;
  end if;
  insert into public.playbook_items (org_id, kind, parent_id, section, title, body, purpose, position, status, created_by, approved_by, approved_at)
  values (p_org, v_kind, v_parent, nullif(trim(p->>'section'), ''), v_title, v_body, coalesce(nullif(p->>'purpose', ''), 'sales'),
    coalesce((select max(position) + 1 from public.playbook_items where org_id = p_org and kind = v_kind), 1), st, auth.uid(),
    case when mgr then auth.uid() end, case when mgr then now() end)
  returning id into v_id;
  return v_id;
end $$;

-- Objections I can see, each with its answers and how they did: raised in N calls, M of those leads bought;
-- per answer: used in N calls, M bought.
create or replace function public.objection_list(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare mgr boolean := public.is_org_manager(p_org); res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not a member'; end if;
  with vis as (
    select * from public.playbook_items i where i.org_id = p_org and i.kind in ('objection', 'answer')
      and i.status <> 'archived' and (i.status = 'published' or i.created_by = auth.uid() or mgr)
  ), used as (
    select (e->>'id') oid, nullif(e->>'answer', '') aid, c.lead_id
    from public.calls c, jsonb_array_elements(c.outcome_data->'objections') e
    where c.org_id = p_org and jsonb_typeof(c.outcome_data->'objections') = 'array' and c.started_at > now() - interval '365 days'
  ), ostat as (
    select u.oid, count(*) n, count(distinct u.lead_id) filter (where l.won_at is not null) won from used u left join public.leads l on l.id = u.lead_id group by u.oid
  ), astat as (
    select u.aid, count(*) n, count(distinct u.lead_id) filter (where l.won_at is not null) won from used u left join public.leads l on l.id = u.lead_id
    where u.aid is not null group by u.aid
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'title', o.title, 'body', o.body, 'section', o.section, 'status', o.status, 'mine', o.created_by = auth.uid(),
      'by', (select full_name from public.profiles where id = o.created_by),
      'raised', coalesce(os.n, 0), 'bought', coalesce(os.won, 0),
      'answer_used', coalesce((select n from astat where aid = o.id::text), 0), 'answer_bought', coalesce((select won from astat where aid = o.id::text), 0),
      'answers', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'status', a.status, 'mine', a.created_by = auth.uid(),
          'by', (select full_name from public.profiles where id = a.created_by),
          'used', coalesce(ast.n, 0), 'bought', coalesce(ast.won, 0)) order by coalesce(ast.won, 0) desc, coalesce(ast.n, 0) desc, a.position)
        from vis a left join astat ast on ast.aid = a.id::text where a.parent_id = o.id), '[]'::jsonb)
    ) order by coalesce(os.n, 0) desc, o.position), '[]'::jsonb) into res
  from vis o left join ostat os on os.oid = o.id::text
  where o.kind = 'objection';
  return res;
end $$;

-- Approve / reject now also works for answers (unchanged function, re-stated for clarity of grants).
revoke execute on function public.set_lead_profile(uuid, jsonb) from anon, public;
revoke execute on function public.pin_lead_note(uuid, text, text, boolean) from anon, public;
revoke execute on function public.save_objection(uuid, jsonb) from anon, public;
revoke execute on function public.objection_list(uuid) from anon, public;
revoke execute on function public.t_call_last_note() from anon, public, authenticated;
revoke execute on function public.t_note_last_note() from anon, public, authenticated;
grant execute on function public.set_lead_profile(uuid, jsonb) to authenticated;
grant execute on function public.pin_lead_note(uuid, text, text, boolean) to authenticated;
grant execute on function public.save_objection(uuid, jsonb) to authenticated;
grant execute on function public.objection_list(uuid) to authenticated;
