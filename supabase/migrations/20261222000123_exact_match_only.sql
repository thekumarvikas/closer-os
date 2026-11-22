-- Owner (Nov 22): leads are merged ONLY when the exact same phone number or the exact same email is on two leads.
-- Never by name, never by a typo, never by Gmail dots / "+tag". (Phone compared on its last 10 digits so "+91 98…" =
-- "98…"; email compared lower-case with spaces removed.) Also undoes the 5 merges made by the name/typo rule of 0122.

-- 1. Email key = the email itself (lower-case, no spaces). No typo fixing, no dot / +tag removal.
create or replace function public.email_key(raw text) returns text language sql immutable as $$ select public.clean_email(raw) $$;
drop index if exists public.leads_org_email_key;
alter table public.leads drop column email_key;
alter table public.leads add column email_key text generated always as (public.email_key(email)) stored;
create index leads_org_email_key on public.leads (org_id, email_key) where deleted_at is null and email is not null;
update public.lead_emails set email_key = public.email_key(email);

-- 2. Undo the name/typo merges of 0122 (lead comes back with its own number; extra number/email entries removed).
do $$
declare r record;
begin
  for r in select o.id oid, o.phone ophone, o.email oemail, o.merged_into kid
           from public.leads o join public.lead_activities a on a.lead_id = o.merged_into and a.kind = 'merged'
             and (a.data->>'auto')::boolean and a.data->>'from' = o.id::text
           where o.deleted_at is not null loop
    update public.leads set deleted_at = null, merged_into = null, updated_at = now() where id = r.oid;
    delete from public.lead_phones where lead_id = r.kid and phone = r.ophone;
    delete from public.lead_emails where lead_id = r.kid and email = r.oemail;
    -- calls with this person's own number go back to them
    update public.calls set lead_id = r.oid where lead_id = r.kid and public.phone_key(phone) = public.phone_key(r.ophone);
    -- webinar registrations: they were in the same webinars (merge kept one row) → give them their own row back
    insert into public.batch_leads (batch_id, lead_id, org_id, watch_minutes, attended, chat_count, poll_answered, registered)
      select b.batch_id, r.oid, b.org_id, 0, false, 0, 0, true from public.batch_leads b where b.lead_id = r.kid
      on conflict do nothing;
    update public.lead_origins set lead_id = r.oid where lead_id = r.kid and data->>'phone' = r.ophone;
    insert into public.lead_activities (org_id, lead_id, kind, data)
      select org_id, r.oid, 'unmerged', jsonb_build_object('from', r.kid, 'why', 'not the exact same number or email') from public.leads where id = r.oid;
    perform public.refresh_lead_stats(r.oid); perform public.refresh_lead_stats(r.kid);
  end loop;
end $$;

-- 3. The automatic rule: exact same number or exact same email (also when it is a lead's second number / email).
create or replace function public.same_person_pairs(p_org uuid, p_since timestamptz)
returns table (a uuid, b uuid, why text) language sql stable security definer set search_path = '' as $$
  with l as (select id, org_id, created_at, email_key, phone_key from public.leads where deleted_at is null and (p_org is null or org_id = p_org)),
  ph as (select id, org_id, created_at, phone_key k from l where length(phone_key) >= 8
         union select l.id, l.org_id, l.created_at, public.phone_key(p.phone) from public.lead_phones p join l on l.id = p.lead_id where length(public.phone_key(p.phone)) >= 8),
  em as (select id, org_id, created_at, email_key k from l where position('@' in coalesce(email_key, '')) > 1
         union select l.id, l.org_id, l.created_at, e.email_key from public.lead_emails e join l on l.id = e.lead_id where position('@' in coalesce(e.email_key, '')) > 1)
  select distinct x.id, y.id, 'same number' from ph x join ph y on y.org_id = x.org_id and y.k = x.k and x.id < y.id
   where p_since is null or greatest(x.created_at, y.created_at) >= p_since
  union
  select distinct x.id, y.id, 'same email' from em x join em y on y.org_id = x.org_id and y.k = x.k and x.id < y.id
   where p_since is null or greatest(x.created_at, y.created_at) >= p_since
$$;
revoke all on function public.same_person_pairs(uuid, timestamptz) from public, anon, authenticated;

-- 4. "Possible duplicates" list = only exact number / email matches (no name groups).
create or replace function public.lead_duplicates(p_org uuid, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see duplicates'; end if;
  with keys as (
    select 'phone' how, phone_key k, id from public.leads where org_id = p_org and deleted_at is null and phone_key is not null and length(phone_key) >= 8
    union all
    select 'email', email_key, id from public.leads where org_id = p_org and deleted_at is null and email_key is not null and position('@' in email_key) > 1
  ), groups as (select how, k, array_agg(id order by id) ids from keys group by how, k having count(*) > 1),
  uniq as (select distinct on (ids) how, k, ids from groups order by ids, how desc)
  select coalesce(jsonb_agg(jsonb_build_object('how', how, 'key', k, 'leads', (
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source, 'city', l.city,
        'created_at', l.created_at, 'assigned_to', l.assigned_to, 'calls', l.call_count, 'last_call_at', l.last_call_at,
        'stage_id', l.stage_id) order by l.created_at)
      from public.leads l where l.id = any(u.ids)))), '[]'::jsonb) into res
  from (select * from uniq limit p_limit) u;
  return res;
end $$;
