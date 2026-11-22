-- One person = one lead (owner, Nov 22). Same email (Gmail dots / "+tag" ignored) or the same full name with an email or number
-- that differs only by a typo = the same person → merged automatically, now and every 10 minutes for new leads. Same full
-- name with different details = "Possible duplicates" for a manager to confirm (common names are often different people).
create extension if not exists fuzzystrmatch with schema extensions;

create or replace function public.email_key(raw text) returns text language sql immutable as $$
  with c as (select public.clean_email(raw) e),
  d as (select e, split_part(e, '@', 1) lp, coalesce(public.email_domain_fix(split_part(e, '@', 2)), split_part(e, '@', 2)) dom from c)
  select case when e is null or position('@' in e) = 0 then e
    else (case when dom in ('gmail.com', 'googlemail.com') then replace(split_part(lp, '+', 1), '.', '') else split_part(lp, '+', 1) end)
      || '@' || case when dom = 'googlemail.com' then 'gmail.com' else dom end end
  from d
$$;
-- Recompute the stored keys with the new rule.
drop index if exists public.leads_org_email_key;
alter table public.leads drop column email_key;
alter table public.leads add column email_key text generated always as (public.email_key(email)) stored;
create index leads_org_email_key on public.leads (org_id, email_key) where deleted_at is null and email is not null;
update public.lead_emails set email_key = public.email_key(email);

create or replace function public.name_key(n text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(regexp_replace(trim(coalesce(n, '')), '^(dr|mr|mrs|ms|er|prof)\.?\s+', '', 'i'), '\s+', ' ', 'g')), '')
$$;

create or replace function public.merge_leads(p_keep uuid, p_others uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.leads; o public.leads; v_org uuid; n int := 0;
begin
  select * into k from public.leads where id = p_keep and deleted_at is null;
  if k.id is null then raise exception 'Lead not found'; end if;
  v_org := k.org_id;
  if not (public.is_org_manager(v_org) or current_setting('closeros.system', true) = '1') then raise exception 'Only managers can merge leads'; end if;
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
    update public.lead_emails set lead_id = k.id where lead_id = o.id and not exists (select 1 from public.lead_emails e where e.lead_id = k.id and e.email = lead_emails.email);
    if o.email is not null and o.email_key is distinct from k.email_key and k.email is not null then
      insert into public.lead_emails (org_id, lead_id, email, email_key, label, source) values (v_org, k.id, o.email, o.email_key, 'From merged lead', 'merge') on conflict do nothing;
    end if;
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

-- Pairs that are the same person (sure enough to merge without asking).
create or replace function public.same_person_pairs(p_org uuid, p_since timestamptz)
returns table (a uuid, b uuid, why text) language sql stable security definer set search_path = '' as $$
  with l as (select id, org_id, created_at, email_key, phone_key, public.name_key(name) nk, split_part(email_key, '@', 1) lp, split_part(email_key, '@', 2) dom
             from public.leads where deleted_at is null and (p_org is null or org_id = p_org))
  select x.id, y.id, 'same email' from l x join l y on y.org_id = x.org_id and y.email_key = x.email_key and x.id < y.id
   where x.email_key is not null and position('@' in x.email_key) > 1 and (p_since is null or greatest(x.created_at, y.created_at) >= p_since)
  union
  select x.id, y.id, case when x.dom = y.dom and length(x.lp) >= 5 and extensions.levenshtein(x.lp, y.lp) <= 2 then 'same name, email typo' else 'same name, number typo' end
  from l x join l y on y.org_id = x.org_id and y.nk = x.nk and x.id < y.id
   where x.nk like '% %' and (p_since is null or greatest(x.created_at, y.created_at) >= p_since)
     and ((x.dom <> '' and x.dom = y.dom and length(x.lp) >= 5 and extensions.levenshtein(x.lp, y.lp) <= 2)
       or (length(x.phone_key) = 10 and length(y.phone_key) = 10 and extensions.levenshtein(x.phone_key, y.phone_key) <= 1))
$$;
revoke all on function public.same_person_pairs(uuid, timestamptz) from public, anon, authenticated;

-- Merges every same-person pair (kept lead = most calls, then the oldest). p_since = only pairs touching newer leads.
create or replace function public.auto_merge_people(p_org uuid default null, p_since timestamptz default null)
returns int language plpgsql security definer set search_path = '' as $$
declare r record; k uuid; o uuid; n int := 0;
begin
  perform set_config('closeros.system', '1', true);
  for r in select * from public.same_person_pairs(p_org, p_since) loop
    -- a lead may already have been merged into another one in this run: follow it
    select coalesce(merged_into, id) into k from public.leads where id = r.a;
    select coalesce(merged_into, id) into o from public.leads where id = r.b;
    if k is null or o is null or k = o then continue; end if;
    if (select coalesce(call_count, 0) from public.leads where id = o) > (select coalesce(call_count, 0) from public.leads where id = k)
       or ((select coalesce(call_count, 0) from public.leads where id = o) = (select coalesce(call_count, 0) from public.leads where id = k)
           and (select created_at from public.leads where id = o) < (select created_at from public.leads where id = k)) then
      select o, k into k, o;
    end if;
    perform public.merge_leads(k, array[o]);
    update public.lead_activities set data = data || jsonb_build_object('auto', true, 'why', r.why)
      where id = (select id from public.lead_activities where lead_id = k and kind = 'merged' order by created_at desc limit 1);
    n := n + 1;
  end loop;
  perform set_config('closeros.system', '0', true);
  return n;
end $$;
revoke all on function public.auto_merge_people(uuid, timestamptz) from public, anon, authenticated;

-- Possible duplicates for a manager: same number / email (left over) + same full name with different details.
create or replace function public.lead_duplicates(p_org uuid, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can see duplicates'; end if;
  with keys as (
    select 'phone' how, phone_key k, id from public.leads where org_id = p_org and deleted_at is null and phone_key is not null and length(phone_key) >= 8
    union all
    select 'email', email_key, id from public.leads where org_id = p_org and deleted_at is null and email_key is not null and position('@' in email_key) > 1
    union all
    select 'name', public.name_key(name), id from public.leads where org_id = p_org and deleted_at is null and public.name_key(name) like '% %'
      and public.name_key(name) !~ '^[+0-9 ]+$'
  ), groups as (
    select how, k, array_agg(id order by id) ids from keys group by how, k having count(*) > 1
  ), uniq as (
    select distinct on (ids) how, k, ids from groups order by ids, how desc
  )
  select coalesce(jsonb_agg(jsonb_build_object('how', how, 'key', k, 'leads', (
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source, 'city', l.city,
        'created_at', l.created_at, 'assigned_to', l.assigned_to, 'calls', l.call_count, 'last_call_at', l.last_call_at,
        'stage_id', l.stage_id) order by l.created_at)
      from public.leads l where l.id = any(u.ids))) order by case how when 'phone' then 0 when 'email' then 1 else 2 end), '[]'::jsonb) into res
  from (select * from uniq limit p_limit) u;
  return res;
end $$;

select cron.unschedule('auto-merge-people') where exists (select 1 from cron.job where jobname = 'auto-merge-people');
select cron.schedule('auto-merge-people', '*/10 * * * *', $c$select public.auto_merge_people(null, now() - interval '30 minutes')$c$);
