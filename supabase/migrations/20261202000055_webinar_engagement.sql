-- Webinar engagement: exact presence at the pitch (Zoom join/leave times), chat messages, poll answers,
-- and a warmth score per lead per webinar that feeds the priority (focus) calling list.

alter table public.batches
  add column if not exists started_at timestamptz,          -- actual start (Zoom report); pitch = started_at + pitch_minute
  add column if not exists chat_uploaded_at timestamptz,
  add column if not exists polls_uploaded_at timestamptz,
  add column if not exists poll_questions int not null default 0;

alter table public.batch_leads
  add column if not exists sessions jsonb,                  -- [{join, leave}] from the Zoom attendee report
  add column if not exists zoom_name text,                  -- name shown in Zoom (to match chat / polls)
  add column if not exists at_pitch boolean,                -- exact: inside the webinar at the pitch moment (null = no join/leave times)
  add column if not exists saw_pitch boolean,               -- final answer used everywhere: at_pitch, else watched >= pitch_minute; null = no pitch set / no Zoom data
  add column if not exists chat_count int not null default 0,
  add column if not exists poll_answered int not null default 0,
  add column if not exists warmth int not null default 0,   -- 0–100
  add column if not exists warm_reason text;

create table if not exists public.batch_chat (
  id bigserial primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  sender text not null,
  sent_at timestamptz,
  minute int,                                               -- minute of the webinar
  message text not null
);
create index if not exists batch_chat_lead on public.batch_chat(lead_id);
create index if not exists batch_chat_batch on public.batch_chat(batch_id);

create table if not exists public.batch_poll_answers (
  id bigserial primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  name text, email text,
  question text not null,
  answer text,
  answered_at timestamptz
);
create index if not exists batch_poll_lead on public.batch_poll_answers(lead_id);
create index if not exists batch_poll_batch on public.batch_poll_answers(batch_id);

alter table public.batch_chat enable row level security;
alter table public.batch_poll_answers enable row level security;
drop policy if exists batch_chat_read on public.batch_chat;
create policy batch_chat_read on public.batch_chat for select to authenticated
  using (public.is_org_manager(org_id) or (lead_id is not null and public.lead_visible(lead_id)));
drop policy if exists batch_poll_read on public.batch_poll_answers;
create policy batch_poll_read on public.batch_poll_answers for select to authenticated
  using (public.is_org_manager(org_id) or (lead_id is not null and public.lead_visible(lead_id)));

-- Works out pitch presence + warmth for every lead of a webinar.
create or replace function public.batch_recompute(p_batch uuid)
returns void language plpgsql security definer set search_path = '' as $$
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

  update public.batch_leads bl set
    at_pitch = case when v_pitch_at is null or bl.sessions is null or jsonb_array_length(bl.sessions) = 0 then null
                    else exists (select 1 from jsonb_array_elements(bl.sessions) s
                                 where (s->>'join')::timestamptz <= v_pitch_at and (s->>'leave')::timestamptz >= v_pitch_at) end
  where bl.batch_id = p_batch;

  update public.batch_leads bl set
    saw_pitch = case when b.pitch_minute is null or bl.watch_minutes is null then null
                     when coalesce(bl.watch_minutes, 0) = 0 then false
                     else coalesce(bl.at_pitch, bl.watch_minutes >= b.pitch_minute) end
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
      || case when y.sp then ' · saw the pitch' when y.sp = false and coalesce(y.w, 0) > 0 then ' · missed the pitch' else '' end
      || case when y.cc > 0 then ' · ' || y.cc || ' chat' || case when y.cc > 1 then 's' else '' end else '' end
      || case when y.pa > 0 then ' · answered ' || y.pa || ' poll' || case when y.pa > 1 then 's' else '' end else '' end end reason) x
  where bl.batch_id = p_batch and bl.lead_id = y.lead_id;

  -- leads.updated_at moves so phones re-download the lead with its new warmth.
  update public.leads l set updated_at = now()
  where l.id in (select lead_id from public.batch_leads where batch_id = p_batch);
end $$;
revoke execute on function public.batch_recompute(uuid) from anon, public, authenticated;

create or replace function public.t_batch_recompute() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.pitch_minute is distinct from old.pitch_minute or new.started_at is distinct from old.started_at
     or new.hot_minutes is distinct from old.hot_minutes then
    perform public.batch_recompute(new.id);
  end if;
  return new;
end $$;
drop trigger if exists t_batch_recompute on public.batches;
create trigger t_batch_recompute after update on public.batches for each row execute function public.t_batch_recompute();

-- Zoom attendee report, now with join/leave sessions, the Zoom name and the actual start time.
drop function if exists public.apply_zoom_report(uuid, jsonb);
create or replace function public.apply_zoom_report(p_batch uuid, p_rows jsonb, p_started_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_prefix text; r jsonb; v_lead uuid; v_phone text; v_email text; v_min int;
  by_email int := 0; by_phone int := 0; added int := 0; unmatched jsonb := '[]'::jsonb; matched uuid[] := '{}';
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_email := nullif(lower(trim(r->>'email')), '');
    v_phone := public.normalize_phone(nullif(r->>'phone', ''), v_prefix);
    v_min := greatest(0, coalesce(round((r->>'minutes')::numeric)::int, 0));
    v_lead := null;
    if v_email is not null then
      select id into v_lead from public.leads where org_id = v_org and email = v_email and deleted_at is null
      order by (exists (select 1 from public.batch_leads b where b.batch_id = p_batch and b.lead_id = leads.id)) desc limit 1;
      if v_lead is not null then by_email := by_email + 1; end if;
    end if;
    if v_lead is null and v_phone is not null and length(v_phone) >= 8 then
      select id into v_lead from public.leads where org_id = v_org and phone = v_phone and deleted_at is null;
      if v_lead is null then select lead_id into v_lead from public.lead_phones where org_id = v_org and phone = v_phone; end if;
      if v_lead is not null then by_phone := by_phone + 1; end if;
    end if;

    if v_lead is null then
      unmatched := unmatched || jsonb_build_array(r - 'sessions');
      continue;
    end if;
    if not exists (select 1 from public.batch_leads where batch_id = p_batch and lead_id = v_lead) then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_lead, v_org, true);
      added := added + 1;
    end if;
    update public.batch_leads set
      watch_minutes = case when v_lead = any(matched) then coalesce(watch_minutes, 0) + v_min else v_min end,
      attended = v_min > 0 or attended,
      sessions = case when jsonb_typeof(r->'sessions') <> 'array' then (case when v_lead = any(matched) then sessions end)
                      when v_lead = any(matched) then coalesce(sessions, '[]'::jsonb) || (r->'sessions') else r->'sessions' end,
      zoom_name = coalesce(nullif(trim(r->>'name'), ''), zoom_name)
    where batch_id = p_batch and lead_id = v_lead;
    matched := matched || v_lead;
  end loop;

  update public.batch_leads set watch_minutes = 0, attended = false, sessions = null, at_pitch = null
  where batch_id = p_batch and not (lead_id = any(matched));
  update public.batches set zoom_uploaded_at = now(), started_at = coalesce(p_started_at, started_at) where id = p_batch;
  perform public.batch_recompute(p_batch);
  perform public.write_audit(v_org, 'batch.zoom_uploaded', 'batch', p_batch::text,
    jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added', added, 'unmatched', jsonb_array_length(unmatched)));
  return jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added_to_batch', added, 'unmatched', unmatched);
end $$;
revoke execute on function public.apply_zoom_report(uuid, jsonb, timestamptz) from anon, public;
grant execute on function public.apply_zoom_report(uuid, jsonb, timestamptz) to authenticated;

-- Finds the lead of this webinar for a Zoom name / email (batch leads first).
create or replace function public.batch_match_person(p_batch uuid, p_name text, p_email text)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select l.id from public.leads l join public.batch_leads bl on bl.lead_id = l.id and bl.batch_id = p_batch
      where nullif(lower(trim(p_email)), '') is not null and lower(l.email) = lower(trim(p_email)) and l.deleted_at is null limit 1),
    (select bl.lead_id from public.batch_leads bl where bl.batch_id = p_batch and nullif(trim(p_name), '') is not null
      and lower(trim(bl.zoom_name)) = lower(trim(regexp_replace(p_name, '\s*\(.*\)\s*$', ''))) limit 1),
    (select l.id from public.leads l join public.batch_leads bl on bl.lead_id = l.id and bl.batch_id = p_batch
      where nullif(trim(p_name), '') is not null and lower(trim(l.name)) = lower(trim(regexp_replace(p_name, '\s*\(.*\)\s*$', '')))
        and l.deleted_at is null
      group by l.id having count(*) = 1 limit 1));
$$;
revoke execute on function public.batch_match_person(uuid, text, text) from anon, public, authenticated;

-- Zoom chat. p_rows: [{sender, sent_at (ISO or null), minute (int or null), message}]. Replaces earlier chat of this webinar.
create or replace function public.apply_zoom_chat(p_batch uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; n int; m int; um jsonb;
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  delete from public.batch_chat where batch_id = p_batch;
  insert into public.batch_chat (org_id, batch_id, lead_id, sender, sent_at, minute, message)
  select v_org, p_batch, public.batch_match_person(p_batch, r->>'sender', null), left(trim(r->>'sender'), 200),
         nullif(r->>'sent_at', '')::timestamptz, nullif(r->>'minute', '')::int, left(r->>'message', 4000)
  from jsonb_array_elements(p_rows) r where nullif(trim(r->>'message'), '') is not null and nullif(trim(r->>'sender'), '') is not null;
  get diagnostics n = row_count;
  select count(*) filter (where lead_id is not null) into m from public.batch_chat where batch_id = p_batch;
  select coalesce(jsonb_agg(jsonb_build_object('sender', sender, 'messages', c) order by c desc), '[]') into um
    from (select sender, count(*) c from public.batch_chat where batch_id = p_batch and lead_id is null group by sender) t;
  update public.batches set chat_uploaded_at = now() where id = p_batch;
  perform public.batch_recompute(p_batch);
  perform public.write_audit(v_org, 'batch.chat_uploaded', 'batch', p_batch::text, jsonb_build_object('messages', n, 'matched', m));
  return jsonb_build_object('messages', n, 'matched', m, 'unmatched', um);
end $$;
revoke execute on function public.apply_zoom_chat(uuid, jsonb) from anon, public;
grant execute on function public.apply_zoom_chat(uuid, jsonb) to authenticated;

-- Zoom poll report. p_rows: [{name, email, answered_at, question, answer}]. Replaces earlier polls of this webinar.
create or replace function public.apply_zoom_polls(p_batch uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; n int; m int; q int; um jsonb;
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  delete from public.batch_poll_answers where batch_id = p_batch;
  insert into public.batch_poll_answers (org_id, batch_id, lead_id, name, email, question, answer, answered_at)
  select v_org, p_batch, public.batch_match_person(p_batch, r->>'name', r->>'email'), left(r->>'name', 200), lower(nullif(trim(r->>'email'), '')),
         left(trim(r->>'question'), 1000), left(r->>'answer', 2000), nullif(r->>'answered_at', '')::timestamptz
  from jsonb_array_elements(p_rows) r where nullif(trim(r->>'question'), '') is not null and nullif(trim(r->>'answer'), '') is not null;
  get diagnostics n = row_count;
  select count(distinct lead_id), count(distinct question) into m, q from public.batch_poll_answers where batch_id = p_batch;
  select coalesce(jsonb_agg(distinct coalesce(nullif(name, ''), email)), '[]') into um from public.batch_poll_answers where batch_id = p_batch and lead_id is null;
  update public.batches set polls_uploaded_at = now(), poll_questions = q where id = p_batch;
  perform public.batch_recompute(p_batch);
  perform public.write_audit(v_org, 'batch.polls_uploaded', 'batch', p_batch::text, jsonb_build_object('answers', n, 'people', m));
  return jsonb_build_object('answers', n, 'people', m, 'questions', q, 'unmatched', um);
end $$;
revoke execute on function public.apply_zoom_polls(uuid, jsonb) from anon, public;
grant execute on function public.apply_zoom_polls(uuid, jsonb) to authenticated;

-- Everything a rep needs to know about a lead's webinars, newest first.
create or replace function public.lead_webinars(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.lead_visible(p_lead) then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'batch_id', b.id, 'name', b.name, 'kind', b.kind, 'webinar_at', b.webinar_at, 'started_at', coalesce(b.started_at, b.webinar_at),
      'pitch_minute', b.pitch_minute,
      'pitch_at', case when b.pitch_minute is not null then coalesce(b.started_at, b.webinar_at) + make_interval(mins => b.pitch_minute) end,
      'zoom_uploaded', b.zoom_uploaded_at is not null, 'chat_uploaded', b.chat_uploaded_at is not null,
      'polls_uploaded', b.polls_uploaded_at is not null, 'poll_questions', b.poll_questions,
      'watch_minutes', bl.watch_minutes, 'sessions', bl.sessions, 'at_pitch', bl.at_pitch, 'saw_pitch', bl.saw_pitch,
      'warmth', bl.warmth, 'warm_reason', bl.warm_reason, 'is_repeat', bl.is_repeat,
      'chat', (select coalesce(jsonb_agg(jsonb_build_object('at', c.sent_at, 'minute', c.minute, 'message', c.message) order by c.id), '[]')
               from public.batch_chat c where c.batch_id = b.id and c.lead_id = p_lead),
      'polls', (select coalesce(jsonb_agg(jsonb_build_object('question', p.question, 'answer', p.answer) order by p.id), '[]')
               from public.batch_poll_answers p where p.batch_id = b.id and p.lead_id = p_lead)
    ) order by b.webinar_at desc), '[]'::jsonb)
    from public.batch_leads bl join public.batches b on b.id = bl.batch_id
    where bl.lead_id = p_lead);
end $$;
revoke execute on function public.lead_webinars(uuid) from anon, public;
grant execute on function public.lead_webinars(uuid) to authenticated;
