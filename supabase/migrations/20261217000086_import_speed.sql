-- Round 15 · 1) Lead import must never hit the 8-second statement timeout.
--
-- Measured on a real 1,600-lead company before this migration: 11.5 ms per lead, so a
-- 981-row file needed ~11 s and was cancelled. Three causes, all fixed here.
--
--   a) The round-robin assignment INSERTed the lead and then UPDATEd it: a second row
--      version plus every index written twice, and four triggers run again. 3.9 ms per
--      lead. The assignee is now decided in a BEFORE INSERT trigger, so each lead is
--      written once. Measured after: 5.99 -> 2.10 ms per lead.
--
--   b) find_lead was called once per row. The lookups themselves are index probes and
--      cost ~0.03 ms; the SECURITY DEFINER call around them costs ~1.3 ms. The import
--      now runs the same probes inline, so there is no per-row call. find_lead itself
--      is unchanged and still used by every other caller.
--
--   c) The duplicate-number check scanned a growing array for every row: 481,000 text
--      comparisons on a 981-row file, 12.5 million on a 5,000-row one. Now a temp table
--      with a unique key, which is flat.

-- ───── a) Decide the assignee before the row is written ─────
-- Fires last of the BEFORE INSERT triggers (name order: is_live, prepare, profession,
-- route), so a rep's forced self-assignment in prepare_lead still wins.
create or replace function public.t_lead_route() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if new.assigned_to is null and coalesce(current_setting('closeros.skip_distribution', true), '') <> 'on' then
    v_user := public.pick_assignee(new.org_id, new);
    if v_user is not null then
      new.assigned_to := v_user;
      new.assigned_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_lead_route on public.leads;
create trigger t_lead_route before insert on public.leads
  for each row execute function public.t_lead_route();

-- The after-insert trigger now only records the activity; the UPDATE is gone.
-- (t_seq_lead_assigned lost nothing: it only acts on a lead already in an upcoming
-- webinar, and a brand-new lead joins its batch after this point, where the
-- batch_leads trigger starts the sequence instead.)
create or replace function public.after_lead_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (new.org_id, new.id, auth.uid(), 'created',
          jsonb_build_object('source', new.source, 'assigned_to', new.assigned_to));
  return new;
end $$;

-- ───── b) find_lead: back to the short-circuiting form (one statement per probe,
-- stopping at the first hit). Unchanged behaviour; restated here because an earlier
-- version of this migration rewrote it. ─────
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
revoke execute on function public.find_lead(uuid, text, text) from anon, public, authenticated;

-- ───── c) The import itself ─────
CREATE OR REPLACE FUNCTION public.import_leads(p_org uuid, p_rows jsonb, p_source text DEFAULT NULL::text, p_campaign text DEFAULT NULL::text, p_assign_mode text DEFAULT 'rules'::text, p_assign_to uuid DEFAULT NULL::uuid, p_batch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_prefix text; r jsonb; v_phone text; v_email text; v_ins int := 0; v_dup int := 0; v_bad int := 0; v_joined int := 0;
  v_n int; v_assignee uuid; v_existing uuid; v_new uuid; v_minutes int;
  v_pk text; v_ek text; v_extra boolean;
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

  -- Most companies keep no extra numbers; checking once saves two probes per row.
  select exists (select 1 from public.lead_phones where org_id = p_org) into v_extra;

  create temp table if not exists _imp_seen (phone text primary key) on commit drop;
  truncate pg_temp._imp_seen;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    v_email := nullif(lower(trim(r->>'email')), '');
    v_minutes := nullif(regexp_replace(coalesce(r->>'watch_minutes', ''), '[^0-9]', '', 'g'), '')::int;
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;

    -- The same number twice in one file.
    insert into pg_temp._imp_seen (phone) values (v_phone) on conflict do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then v_dup := v_dup + 1; continue; end if;

    -- Same probes as find_lead, run here so there is no SECURITY DEFINER call per row.
    v_pk := public.phone_key(v_phone);
    v_ek := public.email_key(v_email);
    v_existing := null;
    select id into v_existing from public.leads where org_id = p_org and phone = v_phone and deleted_at is null limit 1;
    if v_existing is null and v_extra then
      select lead_id into v_existing from public.lead_phones where org_id = p_org and phone = v_phone limit 1;
    end if;
    if v_existing is null and v_pk is not null and length(v_pk) >= 8 then
      select id into v_existing from public.leads where org_id = p_org and phone_key = v_pk and deleted_at is null order by created_at limit 1;
      if v_existing is null and v_extra then
        select lp.lead_id into v_existing from public.lead_phones lp join public.leads l on l.id = lp.lead_id and l.deleted_at is null
          where lp.org_id = p_org and public.phone_key(lp.phone) = v_pk limit 1;
      end if;
    end if;
    if v_existing is null and v_ek is not null and position('@' in v_ek) > 1 then
      select id into v_existing from public.leads where org_id = p_org and email_key = v_ek and deleted_at is null order by created_at limit 1;
    end if;

    if v_existing is not null then
      -- Same person again: one lead, with this arrival remembered.
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
