-- Duplicate leads (Nov 2026): one person = one lead. When the same number (or email) comes in again it is NOT a new
-- lead: the existing lead is marked "Repeated" and remembers every place it came from (lead_origins).
-- Matching cleans both sides: phone = exact (with country code) OR last 10 digits; email = trimmed, no spaces,
-- lower case, common provider typos fixed (gmial.com → gmail.com). Existing duplicates can be merged by managers.

-- ───── Cleaning helpers (also used by Buyer Analysis) ─────
create or replace function public.clean_email(raw text) returns text language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(lower(coalesce(raw, '')), '\s', '', 'g'), '^[.,;:''"]+|[.,;:''"]+$', '', 'g'), '')
$$;

-- Common spelling mistakes in the provider part → the right domain (null when nothing to fix).
create or replace function public.email_domain_fix(dom text) returns text language sql immutable as $$
  select case
    when dom in ('gmial.com','gamil.com','gmal.com','gmai.com','gmaill.com','gnail.com','gmail.co','gmail.con','gmail.cm','gmail.om','gmail.comm',
                 'gmeil.com','gemail.com','gimal.com','gmsil.com','gmail.co.in','gmali.com','gmil.com','g.mail.com','gmail.in') then 'gmail.com'
    when dom in ('yaho.com','yahooo.com','yahoo.con','yahoo.co','yhoo.com','yaoo.com','yahho.com') then 'yahoo.com'
    when dom in ('yahoo.co.in.','yaho.co.in','yahoo.coin','yahoo.co.inn') then 'yahoo.co.in'
    when dom in ('hotmial.com','hotmal.com','hotmail.con','hotmail.co','hotmil.com','hotamil.com') then 'hotmail.com'
    when dom in ('outlok.com','outlook.con','outllook.com','outook.com','outlook.co') then 'outlook.com'
    when dom in ('rediffmal.com','redifmail.com','rediffmail.con','rediff.com','redifmal.com') then 'rediffmail.com'
    when dom in ('icloud.con','iclod.com','icoud.com') then 'icloud.com'
    when dom ~ '\.con$' then regexp_replace(dom, '\.con$', '.com')
    when dom ~ '\.cmo$' then regexp_replace(dom, '\.cmo$', '.com')
    when dom ~ '\.ocm$' then regexp_replace(dom, '\.ocm$', '.com')
    else null end
$$;

-- Matching key for an email: cleaned + provider typos fixed.
create or replace function public.email_key(raw text) returns text language sql immutable as $$
  with c as (select public.clean_email(raw) e)
  select case when e is null or position('@' in e) = 0 then e
              else split_part(e, '@', 1) || '@' || coalesce(public.email_domain_fix(split_part(e, '@', 2)), split_part(e, '@', 2)) end
  from c
$$;

-- Matching key for a phone: digits only, last 10 (country code and leading 0 dropped).
create or replace function public.phone_key(raw text) returns text language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(raw, ''), '\D', '', 'g'), 10), '')
$$;

alter table public.leads add column if not exists phone_key text generated always as (public.phone_key(phone)) stored;
alter table public.leads add column if not exists email_key text generated always as (public.email_key(email)) stored;
create index if not exists leads_org_phone_key on public.leads (org_id, phone_key) where deleted_at is null;
create index if not exists leads_org_email_key on public.leads (org_id, email_key) where deleted_at is null and email is not null;
create index if not exists lead_phones_key on public.lead_phones (org_id, (public.phone_key(phone)));

alter table public.leads add column if not exists arrivals int not null default 1;
alter table public.leads add column if not exists last_arrived_at timestamptz;
alter table public.leads add column if not exists merged_into uuid references public.leads(id) on delete set null;

-- The lead this number / email belongs to: exact number → alternate number → same last 10 digits → same email.
create or replace function public.find_lead(p_org uuid, p_phone text, p_email text default null)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid; k text := public.phone_key(p_phone); e text := public.email_key(p_email);
begin
  if p_phone is not null then
    select id into v from public.leads where org_id = p_org and phone = p_phone and deleted_at is null limit 1;
    if v is not null then return v; end if;
    select lead_id into v from public.lead_phones where org_id = p_org and phone = p_phone limit 1;
    if v is not null then return v; end if;
  end if;
  if k is not null and length(k) >= 8 then
    select id into v from public.leads where org_id = p_org and phone_key = k and deleted_at is null order by created_at limit 1;
    if v is not null then return v; end if;
    select lp.lead_id into v from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null
      where lp.org_id = p_org and public.phone_key(lp.phone) = k limit 1;
    if v is not null then return v; end if;
  end if;
  if e is not null and position('@' in e) > 1 then
    select id into v from public.leads where org_id = p_org and email_key = e and deleted_at is null order by created_at limit 1;
  end if;
  return v;
end $$;

-- ───── Where each lead came from ─────
create table if not exists public.lead_origins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null default 'other',          -- first | import | webhook | app | zoom | call | manual | merged | other
  source text, campaign text,
  batch_id uuid references public.batches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  is_first boolean not null default false,
  data jsonb not null default '{}'::jsonb      -- name / email / phone as sent this time
);
create index if not exists lead_origins_lead on public.lead_origins (lead_id, at desc);
create index if not exists lead_origins_org on public.lead_origins (org_id, at desc);
alter table public.lead_origins enable row level security;
drop policy if exists lead_origins_select on public.lead_origins;
create policy lead_origins_select on public.lead_origins for select using (public.lead_visible(lead_id));

-- First arrival of every new lead.
create or replace function public.t_lead_first_origin() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lead_origins (org_id, lead_id, at, kind, source, campaign, user_id, is_first, data)
  values (new.org_id, new.id, new.created_at, 'first', new.source, new.campaign, auth.uid(), true,
    jsonb_strip_nulls(jsonb_build_object('name', nullif(new.name, ''), 'email', new.email, 'phone', new.phone)));
  return new;
end $$;
drop trigger if exists t_lead_first_origin on public.leads;
create trigger t_lead_first_origin after insert on public.leads for each row execute function public.t_lead_first_origin();

-- The same person came in again: remember where from, count it, fill details the lead didn't have, keep a new number.
create or replace function public.lead_arrived(p_lead uuid, p_kind text, p_source text, p_campaign text, p_batch uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.leads; v_prefix text; v_phone text; d jsonb := coalesce(p_data, '{}'::jsonb);
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return; end if;
  select phone_prefix into v_prefix from public.organizations where id = l.org_id;
  v_phone := public.normalize_phone(d->>'phone', v_prefix);
  insert into public.lead_origins (org_id, lead_id, kind, source, campaign, batch_id, user_id, data)
  values (l.org_id, l.id, coalesce(p_kind, 'other'), nullif(trim(p_source), ''), nullif(trim(p_campaign), ''), p_batch, auth.uid(),
    jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(d->>'name'), ''), 'email', public.clean_email(d->>'email'), 'phone', v_phone)));
  update public.leads set arrivals = arrivals + 1, last_arrived_at = now(), updated_at = now(),
    name = case when coalesce(trim(name), '') = '' then coalesce(nullif(trim(d->>'name'), ''), name) else name end,
    email = coalesce(email, public.clean_email(d->>'email')),
    city = coalesce(city, nullif(trim(d->>'city'), '')),
    state = coalesce(state, nullif(trim(d->>'state'), '')),
    profession = coalesce(profession, nullif(trim(d->>'profession'), '')),
    company = coalesce(company, nullif(trim(d->>'company'), ''))
  where id = l.id;
  -- Same person, different number (matched by email): keep the new number as an alternate.
  if v_phone is not null and length(v_phone) >= 8 and v_phone <> l.phone
     and public.phone_key(v_phone) is distinct from l.phone_key
     and not exists (select 1 from public.lead_phones where org_id = l.org_id and phone = v_phone) then
    insert into public.lead_phones (org_id, lead_id, phone, label) values (l.org_id, l.id, v_phone, 'Came in again with this number')
    on conflict do nothing;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'repeated', jsonb_strip_nulls(jsonb_build_object('source', nullif(trim(p_source), ''),
    'campaign', nullif(trim(p_campaign), ''), 'batch_id', p_batch, 'via', p_kind)));
end $$;

-- Existing leads: their first arrival + every webinar they re-joined.
insert into public.lead_origins (org_id, lead_id, at, kind, source, campaign, is_first, data)
select l.org_id, l.id, l.created_at, 'first', l.source, l.campaign, true,
  jsonb_strip_nulls(jsonb_build_object('name', nullif(l.name, ''), 'email', l.email, 'phone', l.phone))
from public.leads l where not exists (select 1 from public.lead_origins o where o.lead_id = l.id);
insert into public.lead_origins (org_id, lead_id, at, kind, campaign, batch_id)
select bl.org_id, bl.lead_id, coalesce(bl.added_at, now()), 'import', b.name, bl.batch_id
from public.batch_leads bl join public.batches b on b.id = bl.batch_id
where bl.is_repeat and not exists (select 1 from public.lead_origins o where o.lead_id = bl.lead_id and o.batch_id = bl.batch_id);
update public.leads l set arrivals = s.n, last_arrived_at = s.last
from (select lead_id, count(*) n, max(at) last from public.lead_origins group by lead_id) s
where s.lead_id = l.id and s.n > 1;

-- ───── Possible duplicates already in the list + merging ─────
-- Groups of leads that look like the same person (same last 10 digits, or same email). Managers only.
create or replace function public.lead_duplicates(p_org uuid, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see duplicates'; end if;
  with keys as (
    select 'phone' how, phone_key k, id from public.leads where org_id = p_org and deleted_at is null and phone_key is not null and length(phone_key) >= 8
    union all
    select 'email', email_key, id from public.leads where org_id = p_org and deleted_at is null and email_key is not null and position('@' in email_key) > 1
  ), groups as (
    select how, k, array_agg(id order by id) ids from keys group by how, k having count(*) > 1
  ), uniq as (
    select distinct on (ids) how, k, ids from groups order by ids, how desc
  )
  select coalesce(jsonb_agg(jsonb_build_object('how', how, 'key', k, 'leads', (
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source,
        'created_at', l.created_at, 'assigned_to', l.assigned_to, 'calls', l.call_count, 'last_call_at', l.last_call_at,
        'stage_id', l.stage_id) order by l.created_at)
      from public.leads l where l.id = any(u.ids))) ), '[]'::jsonb) into res
  from (select * from uniq limit p_limit) u;
  return res;
end $$;

-- Merges leads into one: calls, notes, follow-ups, webinars, WhatsApp, sequences, shares, numbers and origins move to the
-- kept lead; its empty details are filled from the others; the others are hidden (deleted_at, merged_into). Managers only.
create or replace function public.merge_leads(p_keep uuid, p_others uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.leads; o public.leads; v_org uuid; n int := 0;
begin
  select * into k from public.leads where id = p_keep and deleted_at is null;
  if k.id is null then raise exception 'Lead not found'; end if;
  v_org := k.org_id;
  if not public.is_org_manager(v_org) then raise exception 'Only managers can merge leads'; end if;
  for o in select * from public.leads where id = any(p_others) and id <> p_keep and org_id = v_org and deleted_at is null loop
    update public.calls set lead_id = k.id where lead_id = o.id;
    update public.follow_ups set lead_id = k.id where lead_id = o.id;
    update public.lead_activities set lead_id = k.id where lead_id = o.id;
    update public.wa_messages set lead_id = k.id where lead_id = o.id;
    update public.wa_scheduled set lead_id = k.id where lead_id = o.id;
    update public.wa_sequence_sends set lead_id = k.id where lead_id = o.id;
    update public.call_requests set lead_id = k.id where lead_id = o.id;
    update public.batch_chat set lead_id = k.id where lead_id = o.id;
    update public.batch_poll_answers set lead_id = k.id where lead_id = o.id;
    update public.lead_source_events set lead_id = k.id where lead_id = o.id;
    update public.lead_origins set lead_id = k.id, is_first = false where lead_id = o.id;
    -- Webinars: keep the better attendance when both were registered.
    update public.batch_leads kb set watch_minutes = greatest(coalesce(kb.watch_minutes, 0), coalesce(ob.watch_minutes, 0)),
      attended = kb.attended or ob.attended, reminder_by = coalesce(kb.reminder_by, ob.reminder_by)
    from public.batch_leads ob where ob.lead_id = o.id and kb.lead_id = k.id and kb.batch_id = ob.batch_id;
    delete from public.batch_leads ob where ob.lead_id = o.id and exists (select 1 from public.batch_leads kb where kb.lead_id = k.id and kb.batch_id = ob.batch_id);
    update public.batch_leads set lead_id = k.id where lead_id = o.id;
    -- Sequences: one live run per sequence; a second live one is stopped.
    update public.wa_sequence_leads s set status = 'stopped' where s.lead_id = o.id and s.status in ('active', 'paused')
      and exists (select 1 from public.wa_sequence_leads x where x.lead_id = k.id and x.sequence_id = s.sequence_id and x.status in ('active', 'paused'));
    update public.wa_sequence_leads set lead_id = k.id where lead_id = o.id;
    insert into public.lead_shares (lead_id, org_id, user_id, shared_by) select k.id, v_org, user_id, shared_by from public.lead_shares where lead_id = o.id on conflict do nothing;
    delete from public.lead_shares where lead_id = o.id;
    update public.lead_phones set lead_id = k.id where lead_id = o.id;
    if o.phone_key is distinct from k.phone_key then
      insert into public.lead_phones (org_id, lead_id, phone, label) values (v_org, k.id, o.phone, 'From merged lead') on conflict do nothing;
    end if;
    -- Fill what the kept lead is missing.
    update public.leads set
      name = case when coalesce(trim(name), '') = '' then o.name else name end,
      email = coalesce(email, o.email), city = coalesce(city, o.city), state = coalesce(state, o.state),
      profession = coalesce(profession, o.profession), company = coalesce(company, o.company),
      key_facts = case when coalesce(key_facts, '') = '' then o.key_facts when coalesce(o.key_facts, '') = '' then key_facts else key_facts || ' · ' || o.key_facts end,
      notes = case when coalesce(notes, '') = '' then o.notes when coalesce(o.notes, '') = '' then notes else notes || E'\n' || o.notes end,
      tags = (select array(select distinct unnest(coalesce(tags, '{}') || coalesce(o.tags, '{}')))),
      custom = coalesce(o.custom, '{}'::jsonb) || coalesce(custom, '{}'::jsonb),
      assigned_to = coalesce(assigned_to, o.assigned_to),
      arrivals = arrivals + o.arrivals, last_arrived_at = greatest(last_arrived_at, o.last_arrived_at, o.created_at),
      updated_at = now()
    where id = k.id;
    -- The phone number index only allows one live lead per number: free it first.
    update public.leads set deleted_at = now(), merged_into = k.id, updated_at = now() where id = o.id;
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (v_org, k.id, auth.uid(), 'merged', jsonb_build_object('from', o.id, 'name', o.name, 'phone', o.phone));
    n := n + 1;
  end loop;
  perform public.refresh_lead_stats(k.id);
  perform public.write_audit(v_org, 'leads.merged', 'lead', k.id::text, jsonb_build_object('merged', p_others, 'count', n));
  return jsonb_build_object('merged', n, 'lead_id', k.id);
end $$;

-- Where a lead came from (newest first), for the lead page and dashboard.
create or replace function public.lead_origin_list(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('at', o.at, 'kind', o.kind, 'source', o.source, 'campaign', o.campaign,
      'batch', b.name, 'first', o.is_first, 'by', p.full_name, 'data', o.data) order by o.at desc)
    from public.lead_origins o left join public.batches b on b.id = o.batch_id left join public.profiles p on p.id = o.user_id
    where o.lead_id = p_lead), '[]'::jsonb);
end $$;

revoke execute on function public.find_lead(uuid, text, text) from anon, public, authenticated;
revoke execute on function public.lead_arrived(uuid, text, text, text, uuid, jsonb) from anon, public, authenticated;
revoke execute on function public.t_lead_first_origin() from anon, public, authenticated;
revoke execute on function public.lead_duplicates(uuid, int) from anon, public;
revoke execute on function public.merge_leads(uuid, uuid[]) from anon, public;
revoke execute on function public.lead_origin_list(uuid) from anon, public;
grant execute on function public.lead_duplicates(uuid, int) to authenticated;
grant execute on function public.merge_leads(uuid, uuid[]) to authenticated;
grant execute on function public.lead_origin_list(uuid) to authenticated;
grant execute on function public.clean_email(text) to authenticated;
grant execute on function public.email_key(text) to authenticated;
grant execute on function public.phone_key(text) to authenticated;
grant execute on function public.email_domain_fix(text) to authenticated;

-- ───── Every way a lead comes in now uses the same matching and records repeats ─────
CREATE OR REPLACE FUNCTION public.import_leads(p_org uuid, p_rows jsonb, p_source text DEFAULT NULL::text, p_campaign text DEFAULT NULL::text, p_assign_mode text DEFAULT 'rules'::text, p_assign_to uuid DEFAULT NULL::uuid, p_batch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_prefix text; r jsonb; v_phone text; v_email text; v_ins int := 0; v_dup int := 0; v_bad int := 0; v_joined int := 0;
  v_seen text[] := '{}'; v_assignee uuid; v_existing uuid; v_new uuid; v_minutes int;
  std text[] := array['name','phone','email','country','state','city','timezone','profession','company','source','campaign','notes','deal_value','tags','watch_minutes'];
begin
  if not public.is_org_manager(p_org) then raise exception 'Only admins and managers can import leads'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_assign_mode = 'user' and (p_assign_to is null or not public.can_see_user(p_org, p_assign_to)) then
    raise exception 'Choose someone you manage to assign these leads to';
  end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then
    raise exception 'Unknown webinar batch';
  end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  if p_assign_mode <> 'rules' then perform set_config('closeros.skip_distribution', 'on', true); end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    v_email := nullif(lower(trim(r->>'email')), '');
    v_minutes := nullif(regexp_replace(coalesce(r->>'watch_minutes', ''), '[^0-9]', '', 'g'), '')::int;
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;
    if v_phone = any(v_seen) then v_dup := v_dup + 1; continue; end if;
    v_seen := v_seen || v_phone;

    v_existing := public.find_lead(p_org, v_phone, v_email);

    if v_existing is not null then
      -- Same person again: one lead, marked Repeated, with this source remembered.
      perform public.lead_arrived(v_existing, 'import', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign), p_batch, r);
      if p_batch is null then v_dup := v_dup + 1; continue; end if;
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended)
      values (p_batch, v_existing, p_org, true, v_minutes, coalesce(v_minutes, 0) > 0)
      on conflict (batch_id, lead_id) do update set watch_minutes = coalesce(excluded.watch_minutes, public.batch_leads.watch_minutes),
        attended = public.batch_leads.attended or excluded.attended;
      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (p_org, v_existing, auth.uid(), 'batch_joined', jsonb_build_object('batch_id', p_batch, 'repeat', true));
      v_joined := v_joined + 1;
      continue;
    end if;

    v_assignee := case p_assign_mode when 'user' then p_assign_to else null end;
    insert into public.leads (org_id, name, phone, email, country, state, city, timezone, profession, company,
                              source, campaign, notes, deal_value, tags, custom, assigned_to)
    values (
      p_org, coalesce(r->>'name', ''), v_phone, v_email, r->>'country', r->>'state', r->>'city', r->>'timezone',
      r->>'profession', r->>'company', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign),
      r->>'notes', nullif(regexp_replace(coalesce(r->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric,
      coalesce(array(select trim(x) from unnest(string_to_array(r->>'tags', ',')) x where trim(x) <> ''), '{}'),
      coalesce(r->'custom', '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(r) as e(k, v) where k <> 'custom' and not k = any(std)), '{}'::jsonb),
      v_assignee
    ) returning id into v_new;
    if p_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended)
      values (p_batch, v_new, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0);
    end if;
    v_ins := v_ins + 1;
  end loop;

  perform set_config('closeros.skip_distribution', 'off', true);
  perform public.write_audit(p_org, 'leads.imported', 'lead', null,
    jsonb_build_object('inserted', v_ins, 'joined_batch', v_joined, 'duplicates', v_dup, 'invalid', v_bad, 'source', p_source, 'batch', p_batch));
  return jsonb_build_object('inserted', v_ins, 'joined', v_joined, 'duplicates', v_dup, 'invalid', v_bad);
end $function$;

CREATE OR REPLACE FUNCTION public.ingest_lead(p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.lead_sources; f jsonb; m jsonb; v_prefix text;
  v_name text; v_phone text; v_email text; v_first text; v_last text; v_status text; v_lead uuid; v_minutes int;
  std text[] := array['name','full_name','fullname','first_name','last_name','phone','phone_number','mobile','email'];
  v_custom jsonb;
begin
  select * into s from public.lead_sources where token = p_token;
  if s.id is null or not s.is_active then
    return jsonb_build_object('ok', false, 'error', 'Unknown or paused lead source');
  end if;
  -- Google Ads sends its webhook key with every lead; reject if it doesn't match.
  if s.google_key is not null and s.google_key <> '' and p_payload ? 'google_key' and p_payload->>'google_key' <> s.google_key then
    return jsonb_build_object('ok', false, 'error', 'Wrong Google key');
  end if;

  f := public.flatten_lead_payload(p_payload);
  m := s.field_map;
  select phone_prefix into v_prefix from public.organizations where id = s.org_id;

  v_first := public.pick_lead_field(f, m, 'first_name', array['first_name', 'firstname', 'fname', 'given_name']);
  v_last := public.pick_lead_field(f, m, 'last_name', array['last_name', 'lastname', 'lname', 'family_name', 'surname']);
  v_name := coalesce(public.pick_lead_field(f, m, 'name', array['full_name', 'fullname', 'name', 'your_name', 'customer_name', 'contact_name', 'lead_name', 'sender_name']),
                     nullif(trim(concat_ws(' ', v_first, v_last)), ''), '');
  v_phone := public.normalize_phone(public.pick_lead_field(f, m, 'phone', array['phone_number', 'phone', 'mobile', 'mobile_number', 'mobile_no', 'contact', 'contact_number',
               'whatsapp', 'whatsapp_number', 'phone_no', 'cell', 'telephone', 'number', 'sender_mobile', 'user_phone']), v_prefix);
  v_email := lower(public.pick_lead_field(f, m, 'email', array['email', 'email_address', 'e_mail', 'mail', 'your_email', 'sender_email', 'user_email']));

  if coalesce((p_payload->>'is_test')::boolean, false) then
    insert into public.lead_source_events (source_id, org_id, payload, status) values (s.id, s.org_id, p_payload, 'test');
    update public.lead_sources set last_received_at = now() where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'test');
  end if;

  if v_phone is null or length(v_phone) < 8 then
    insert into public.lead_source_events (source_id, org_id, payload, status, error)
    values (s.id, s.org_id, p_payload, 'error', 'No valid phone number found');
    update public.lead_sources set last_received_at = now(), received_count = received_count + 1 where id = s.id;
    return jsonb_build_object('ok', false, 'error', 'No valid phone number found');
  end if;

  -- Everything we didn't map is kept as custom fields (e.g. "what is your profession").
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_custom
  from jsonb_each_text(f) as e(k, v)
  where not k = any(std) and v <> '' and k not like '%.%' and k not in ('google_key', 'api_version', 'is_test', 'lead_id', 'form_id', 'gcl_id', 'adgroup_id', 'creative_id');

  v_lead := public.find_lead(s.org_id, v_phone, v_email);

  if v_lead is not null then
    v_status := 'duplicate';
    perform public.lead_arrived(v_lead, 'webhook', coalesce(s.source_label, s.name),
      coalesce(public.pick_lead_field(f, m, 'campaign', array['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']), s.campaign), s.batch_id,
      jsonb_build_object('name', v_name, 'email', v_email, 'phone', v_phone,
        'city', public.pick_lead_field(f, m, 'city', array['city', 'town', 'location']),
        'profession', public.pick_lead_field(f, m, 'profession', array['profession', 'occupation', 'job_title', 'what_do_you_do', 'industry', 'business_type', 'work'])));
    if s.batch_id is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (s.batch_id, v_lead, s.org_id, true)
      on conflict (batch_id, lead_id) do nothing;
      if found then
        v_status := 'joined';
        insert into public.lead_activities (org_id, lead_id, kind, data)
        values (s.org_id, v_lead, 'batch_joined', jsonb_build_object('batch_id', s.batch_id, 'repeat', true, 'source', s.name));
      end if;
    end if;
  else
    if s.assign_mode <> 'rules' then perform set_config('closeros.skip_distribution', 'on', true); end if;
    insert into public.leads (org_id, name, phone, email, city, state, profession, company, source, campaign, notes, custom, assigned_to)
    values (
      s.org_id, v_name, v_phone, v_email,
      public.pick_lead_field(f, m, 'city', array['city', 'town', 'location']),
      public.pick_lead_field(f, m, 'state', array['state', 'region', 'province']),
      public.pick_lead_field(f, m, 'profession', array['profession', 'occupation', 'job_title', 'what_do_you_do', 'industry', 'business_type', 'work']),
      public.pick_lead_field(f, m, 'company', array['company', 'company_name', 'business_name', 'organisation', 'organization', 'sender_company']),
      coalesce(s.source_label, s.name),
      coalesce(public.pick_lead_field(f, m, 'campaign', array['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']), s.campaign),
      public.pick_lead_field(f, m, 'notes', array['message', 'notes', 'comments', 'query', 'enquiry', 'requirement', 'query_message']),
      v_custom,
      case when s.assign_mode = 'user' then s.assign_to else null end
    ) returning id into v_lead;
    perform set_config('closeros.skip_distribution', 'off', true);
    v_minutes := nullif(regexp_replace(coalesce(public.pick_lead_field(f, m, 'watch_minutes', array['watch_minutes']), ''), '[^0-9]', '', 'g'), '')::int;
    if s.batch_id is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes) values (s.batch_id, v_lead, s.org_id, false, v_minutes)
      on conflict do nothing;
    end if;
    v_status := 'created';
  end if;

  insert into public.lead_source_events (source_id, org_id, payload, status, lead_id) values (s.id, s.org_id, p_payload, v_status, v_lead);
  update public.lead_sources set last_received_at = now(), received_count = received_count + 1 where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_status, 'lead_id', v_lead);
exception when others then
  insert into public.lead_source_events (source_id, org_id, payload, status, error)
  values (s.id, s.org_id, p_payload, 'error', sqlerrm);
  return jsonb_build_object('ok', false, 'error', 'Could not save this lead');
end $function$;

CREATE OR REPLACE FUNCTION public.import_my_leads(p_org uuid, p_rows jsonb, p_batch uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prefix text; r jsonb; v_phone text; v_id uuid; v_ins int := 0; v_already int := 0; v_bad int := 0; v_joined int := 0; v_seen text[] := '{}';
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then raise exception 'Unknown event'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  perform set_config('closeros.skip_distribution', 'on', true);
  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;
    if v_phone = any(v_seen) then v_already := v_already + 1; continue; end if;
    v_seen := v_seen || v_phone;
    v_id := null;
    v_id := public.find_lead(p_org, v_phone, r->>'email');
    if v_id is not null then
      v_already := v_already + 1;
      perform public.lead_arrived(v_id, 'app', coalesce(nullif(trim(r->>'source'), ''), p_source, 'Imported in app'), nullif(trim(r->>'campaign'), ''), p_batch, r);
      if p_batch is not null then
        insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_id, p_org, true) on conflict do nothing;
        if found then v_joined := v_joined + 1; update public.leads set updated_at = now() where id = v_id; end if;
      end if;
      continue;
    end if;
    insert into public.leads (org_id, name, phone, email, city, state, profession, company, notes, source, campaign, assigned_to)
    values (p_org, coalesce(trim(r->>'name'), ''), v_phone, nullif(lower(trim(r->>'email')), ''), nullif(trim(r->>'city'), ''),
      nullif(trim(r->>'state'), ''), nullif(trim(r->>'profession'), ''), nullif(trim(r->>'company'), ''), nullif(trim(r->>'notes'), ''),
      coalesce(nullif(trim(r->>'source'), ''), p_source, 'Imported in app'), nullif(trim(r->>'campaign'), ''), auth.uid())
    returning id into v_id;
    if p_batch is not null then insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_id, p_org, false) on conflict do nothing; end if;
    v_ins := v_ins + 1;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'already', v_already, 'joined', v_joined, 'invalid', v_bad);
end $function$;

CREATE OR REPLACE FUNCTION public.add_lead(p_org uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prefix text; v_phone text; v_id uuid; v_batch uuid := nullif(p->>'batch_id', '')::uuid;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  v_phone := public.normalize_phone(p->>'phone', v_prefix);
  if v_phone is null or length(v_phone) < 8 then raise exception 'Enter a valid phone number'; end if;
  v_id := public.find_lead(p_org, v_phone, p->>'email');
  if v_id is not null then
    perform public.lead_arrived(v_id, 'app', coalesce(nullif(trim(p->>'source'), ''), 'Added in app'), null, v_batch, p);
    if v_batch is not null and exists (select 1 from public.batches where id = v_batch and org_id = p_org) then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (v_batch, v_id, p_org, true) on conflict do nothing;
      update public.leads set updated_at = now() where id = v_id;
    end if;
    return jsonb_build_object('id', v_id, 'existing', true);
  end if;
  perform set_config('closeros.skip_distribution', 'on', true);
  insert into public.leads (org_id, name, phone, email, city, state, profession, company, notes, source, assigned_to)
  values (p_org, coalesce(trim(p->>'name'), ''), v_phone, nullif(lower(trim(p->>'email')), ''), nullif(trim(p->>'city'), ''),
    nullif(trim(p->>'state'), ''), nullif(trim(p->>'profession'), ''), nullif(trim(p->>'company'), ''), nullif(trim(p->>'notes'), ''),
    coalesce(nullif(trim(p->>'source'), ''), 'Added in app'), auth.uid())
  returning id into v_id;
  if v_batch is not null and exists (select 1 from public.batches where id = v_batch and org_id = p_org) then
    insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (v_batch, v_id, p_org, false) on conflict do nothing;
  end if;
  return jsonb_build_object('id', v_id, 'existing', false);
end $function$;

CREATE OR REPLACE FUNCTION public.log_call(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_id uuid := (p->>'id')::uuid;
  v_lead uuid := nullif(p->>'lead_id', '')::uuid;
  v_outcome uuid := nullif(p->>'outcome_id', '')::uuid;
  v_follow timestamptz := nullif(p->>'follow_up_at', '')::timestamptz;
  v_no_follow boolean := coalesce((p->>'no_follow_up')::boolean, false);
  v_stage uuid := nullif(p->>'stage_id', '')::uuid;
  v_purpose text := coalesce(nullif(p->>'purpose', ''), 'sales');
  v_batch uuid := nullif(p->>'batch_id', '')::uuid;
  v_prefix text; v_cat public.outcome_category; v_code text; v_fu uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member of this company'; end if;
  if v_purpose not in ('sales', 'reminder') then raise exception 'Unknown call purpose'; end if;
  -- A call with a number that isn't in the lead list (after-call pop-up): add it as a lead now, assigned to the caller.
  if v_lead is null and coalesce((p->>'create_lead')::boolean, false) and coalesce(p->>'phone', '') <> '' then
    v_lead := public.find_lead(v_org, public.normalize_phone(p->>'phone', (select o.phone_prefix from public.organizations o where o.id = v_org)), null);
    if v_lead is null then
      insert into public.leads (org_id, name, phone, source, assigned_to)
      values (v_org, coalesce(nullif(trim(p->>'lead_name'), ''), ''),
        coalesce(public.normalize_phone(p->>'phone', (select o.phone_prefix from public.organizations o where o.id = v_org)), p->>'phone'), 'Phone call', auth.uid())
      returning id into v_lead;
    end if;
  end if;
  if v_lead is not null and not public.lead_visible(v_lead) then raise exception 'Lead not found'; end if;
  if v_batch is not null and not exists (select 1 from public.batches where id = v_batch and org_id = v_org) then
    raise exception 'Unknown webinar batch';
  end if;
  if v_outcome is not null then
    select category, code into v_cat, v_code from public.call_outcomes where id = v_outcome and org_id = v_org;
    if v_cat is null then raise exception 'Unknown outcome'; end if;
    if v_follow is null and not v_no_follow then
      raise exception 'Choose the next call time or "No follow-up needed"';
    end if;
  end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;

  insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                            duration_sec, sim_slot, sim_label, outcome_id, outcome_data, notes, from_dialer_queue,
                            recording_status, purpose, batch_id, sim_number)
  values (
    v_id, v_org, v_lead, auth.uid(), p->>'device_id', (p->>'direction')::public.call_direction,
    public.normalize_phone(p->>'phone', v_prefix), (p->>'started_at')::timestamptz, nullif(p->>'ended_at', '')::timestamptz,
    coalesce((p->>'duration_sec')::int, 0), nullif(p->>'sim_slot', '')::int, p->>'sim_label', v_outcome,
    coalesce(p->'outcome_data', '{}'::jsonb), p->>'notes', coalesce((p->>'from_dialer_queue')::boolean, false),
    coalesce(nullif(p->>'recording_status', ''), 'not_expected')::public.recording_status, v_purpose, v_batch,
    public.normalize_phone(nullif(p->>'sim_number', ''), v_prefix)
  )
  on conflict (id) do update set
    outcome_id = coalesce(excluded.outcome_id, public.calls.outcome_id),
    outcome_data = case when excluded.outcome_id is not null then excluded.outcome_data else public.calls.outcome_data end,
    notes = coalesce(excluded.notes, public.calls.notes),
    lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
    ended_at = coalesce(excluded.ended_at, public.calls.ended_at),
    duration_sec = greatest(excluded.duration_sec, public.calls.duration_sec),
    recording_status = excluded.recording_status,
    purpose = excluded.purpose,
    batch_id = coalesce(excluded.batch_id, public.calls.batch_id),
    sim_number = coalesce(excluded.sim_number, public.calls.sim_number)
  where public.calls.user_id = auth.uid();

  if v_lead is not null then
    update public.leads set
      last_call_at = greatest(coalesce(last_call_at, '-infinity'), (p->>'started_at')::timestamptz),
      last_outcome_id = coalesce(v_outcome, last_outcome_id),
      stage_id = coalesce(v_stage, stage_id),
      profession = coalesce(nullif(p->>'profession', ''), profession),
      profession_category_id = coalesce(nullif(p->>'profession_category_id', '')::uuid, profession_category_id),
      do_not_call = do_not_call or v_code = 'do_not_call',
      deal_value = coalesce(nullif(p->'outcome_data'->>'deal_value', '')::numeric, nullif(p->'outcome_data'->>'amount', '')::numeric, deal_value),
      notes = case when nullif(p->>'notes', '') is null then notes
                   else concat_ws(E'\n', notes, to_char(now() at time zone 'Asia/Kolkata', 'DD/MM HH24:MI') || ': ' || (p->>'notes')) end
    where id = v_lead;

    -- Facts captured on the outcome form (company's "facts to capture") and quick tags go onto the lead.
    if jsonb_typeof(p->'lead_custom') = 'object' then
      update public.leads set custom = coalesce(custom, '{}'::jsonb) || (p->'lead_custom') where id = v_lead;
    end if;
    if jsonb_typeof(p->'lead_tags') = 'array' then
      update public.leads set tags = array(select distinct t from unnest(coalesce(tags, '{}') || array(select jsonb_array_elements_text(p->'lead_tags'))) t)
      where id = v_lead;
    end if;

    if v_outcome is not null then
      -- Each outcome sets the lead's one next-call time for this kind of call (sales or reminder).
      update public.follow_ups
      set status = case when due_at <= now() then 'done'::public.follow_up_status else 'cancelled'::public.follow_up_status end,
          completed_at = now()
      where lead_id = v_lead and status = 'pending' and purpose = v_purpose
        -- Shared lead: each person keeps their own next call; only the caller's closes.
        and (not exists (select 1 from public.leads x where x.id = v_lead and cardinality(x.shared_with) > 0)
             or assigned_to = auth.uid());

      if v_follow is not null then
        insert into public.follow_ups (org_id, lead_id, assigned_to, due_at, reason, notes, call_id, created_by, priority, purpose)
        values (v_org, v_lead,
                case when v_purpose = 'reminder' or exists (select 1 from public.leads x where x.id = v_lead and auth.uid() = any(x.shared_with)) then auth.uid()
                     else coalesce((select assigned_to from public.leads where id = v_lead), auth.uid()) end,
                v_follow, p->>'follow_up_reason', p->>'follow_up_notes', v_id, auth.uid(),
                coalesce((p->>'follow_up_priority')::smallint, 2), v_purpose)
        returning id into v_fu;
      end if;
      update public.leads set next_follow_up_at = (
        select min(due_at) from public.follow_ups where lead_id = v_lead and status = 'pending'
      ) where id = v_lead;

      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (v_org, v_lead, auth.uid(), 'call', jsonb_build_object(
        'call_id', v_id, 'direction', p->>'direction', 'duration_sec', p->>'duration_sec', 'purpose', v_purpose,
        'outcome', v_code, 'follow_up_at', v_follow, 'no_follow_up', v_no_follow));
    end if;
  end if;
  return jsonb_build_object('call_id', v_id, 'follow_up_id', v_fu);
end $function$;
