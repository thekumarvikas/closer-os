-- Rule: sales never stay unlinked when the data to link them exists.
-- Repeat arrivals keep the file's columns, sign-up time and webinar; a gap filler runs after imports and every hour.
create or replace function public.sales_fill_gaps(p_org uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare n_lead int; n_web int;
begin
  n_lead := public.rematch_buyers(p_org);
  -- sales of a lead with no webinar yet, or picked automatically: pick again
  with u as (update public.sales s set webinar_batch_id = null
             where s.org_id = p_org and s.lead_id is not null and (s.webinar_batch_id is null or s.webinar_auto) returning s.webinar_batch_id)
  select count(*) filter (where webinar_batch_id is not null) into n_web from u;
  return jsonb_build_object('linked_leads', n_lead, 'with_webinar', n_web);
end $$;
revoke all on function public.sales_fill_gaps(uuid) from public, anon;

CREATE OR REPLACE FUNCTION public.lead_arrived(p_lead uuid, p_kind text, p_source text, p_campaign text, p_batch uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare l public.leads; v_prefix text; v_phone text; v_email text; d jsonb := coalesce(p_data, '{}'::jsonb); v_from text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return; end if;
  select phone_prefix into v_prefix from public.organizations where id = l.org_id;
  v_phone := public.normalize_phone(d->>'phone', v_prefix);
  v_email := public.clean_email(d->>'email');
  v_from := coalesce(nullif(trim(p_source), ''), initcap(coalesce(p_kind, 'other')));
  insert into public.lead_origins (org_id, lead_id, kind, source, campaign, batch_id, user_id, data)
  values (l.org_id, l.id, coalesce(p_kind, 'other'), nullif(trim(p_source), ''), nullif(trim(p_campaign), ''), p_batch, auth.uid(),
    jsonb_strip_nulls(d || jsonb_build_object('name', nullif(trim(d->>'name'), ''), 'email', v_email, 'phone', v_phone)));
  update public.leads set  last_arrived_at = now(), updated_at = now(),
    name = case when coalesce(trim(name), '') = '' then coalesce(nullif(trim(d->>'name'), ''), name) else name end,
    email = coalesce(email, v_email),
    city = coalesce(city, nullif(trim(d->>'city'), '')),
    state = coalesce(state, nullif(trim(d->>'state'), '')),
    profession = coalesce(profession, nullif(trim(d->>'profession'), '')),
    company = coalesce(company, nullif(trim(d->>'company'), '')),
    -- the file's other columns fill what this lead doesn't have yet (what it has stays)
    custom = coalesce(d->'custom', '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(d) e(k, v)
               where k not in ('name','phone','email','country','state','city','timezone','profession','company','source','campaign',
                               'notes','deal_value','tags','watch_minutes','signup_at','custom')), '{}'::jsonb) || coalesce(custom, '{}'::jsonb),
    -- an earlier sign-up time from the file wins
    signup_at = least(coalesce(signup_at, created_at),
                 coalesce(public.signup_guess(coalesce(d->>'signup_at', d->'custom'->>'date', d->'custom'->>'timestamp'),
                   coalesce((select timezone from public.organizations where id = l.org_id), 'Asia/Kolkata'), now(), null), 'infinity'))
  where id = l.id;
  if p_batch is null then
    perform public.lead_join_webinar(l.id, coalesce(d->>'webinar_date', d->'custom'->>'webinar_date'), null);
  end if;
  if v_phone is not null and length(v_phone) >= 8 and v_phone <> l.phone
     and public.phone_key(v_phone) is distinct from l.phone_key
     and not exists (select 1 from public.lead_phones where org_id = l.org_id and public.phone_key(phone) = public.phone_key(v_phone)) then
    insert into public.lead_phones (org_id, lead_id, phone, label, source) values (l.org_id, l.id, v_phone, 'Secondary', v_from)
    on conflict do nothing;
  end if;
  if v_email is not null and position('@' in v_email) > 1 and l.email is not null
     and public.email_key(v_email) is distinct from public.email_key(l.email)
     and not exists (select 1 from public.lead_emails where lead_id = l.id and email_key = public.email_key(v_email)) then
    insert into public.lead_emails (org_id, lead_id, email, email_key, label, source)
    values (l.org_id, l.id, v_email, public.email_key(v_email), 'Secondary', v_from) on conflict do nothing;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'repeated', jsonb_strip_nulls(jsonb_build_object('source', nullif(trim(p_source), ''),
    'campaign', nullif(trim(p_campaign), ''), 'batch_id', p_batch, 'via', p_kind)));
  if p_batch is not null and coalesce(p_source, '') <> 'Zoom attendee' then
    update public.batch_leads set registered = true where batch_id = p_batch and lead_id = l.id and not registered;
  end if;
  perform public.recount_arrivals(p_lead);
end $function$;

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
  -- People added from the Zoom attendance file joined without registering; any other file is a registration list.
  v_reg boolean := coalesce(p_source, '') <> 'Zoom attendee';
  std text[] := array['name','phone','email','country','state','city','timezone','profession','company','source','campaign','notes','deal_value','tags','watch_minutes','signup_at'];
  v_tz text; v_signup timestamptz;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only admins and managers can import leads'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_assign_mode = 'user' and (p_assign_to is null or not public.can_see_user(p_org, p_assign_to)) then
    raise exception 'Choose someone you manage to assign these leads to';
  end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then
    raise exception 'Unknown webinar batch';
  end if;
  select phone_prefix, coalesce(timezone, 'Asia/Kolkata') into v_prefix, v_tz from public.organizations where id = p_org;
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
      if p_batch is null then
                v_dup := v_dup + 1; continue;
      end if;
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended, registered)
      values (p_batch, v_existing, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0, v_reg)
      -- An incoming 0 (a registration file without minutes, after the Zoom report) never wipes real minutes.
      on conflict (batch_id, lead_id) do update set watch_minutes = case when coalesce(excluded.watch_minutes, 0) > 0 then excluded.watch_minutes
                                                                          else coalesce(public.batch_leads.watch_minutes, excluded.watch_minutes) end,
        attended = public.batch_leads.attended or excluded.attended,
        registered = public.batch_leads.registered or excluded.registered;
      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (p_org, v_existing, auth.uid(), 'batch_joined', jsonb_build_object('batch_id', p_batch, 'repeat', true));
      v_joined := v_joined + 1;
      continue;
    end if;

    v_assignee := case p_assign_mode when 'user' then p_assign_to else null end;
    insert into public.leads (org_id, name, phone, email, country, state, city, timezone, profession, company,
                              source, campaign, notes, deal_value, tags, custom, assigned_to, signup_at)
    values (
      p_org, coalesce(r->>'name', ''), v_phone, v_email, r->>'country', r->>'state', r->>'city', r->>'timezone',
      r->>'profession', r->>'company', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign),
      r->>'notes', nullif(regexp_replace(coalesce(r->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric,
      coalesce(array(select trim(x) from unnest(string_to_array(r->>'tags', ',')) x where trim(x) <> ''), '{}'),
      coalesce(r->'custom', '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(r) as e(k, v) where k <> 'custom' and not k = any(std)), '{}'::jsonb),
      v_assignee, coalesce(public.signup_guess(r->>'signup_at', v_tz, now(), (select webinar_at from public.batches where id = p_batch)), now())
    ) returning id into v_new;
    if p_batch is null then perform public.lead_join_webinar(v_new, coalesce(r->>'webinar_date', r->'custom'->>'webinar_date'), null); end if;
    if p_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended, registered)
      values (p_batch, v_new, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0, v_reg);
    end if;
    v_ins := v_ins + 1;
  end loop;

  perform set_config('closeros.skip_distribution', 'off', true);
  perform public.write_audit(p_org, 'leads.imported', 'lead', null,
    jsonb_build_object('inserted', v_ins, 'joined_batch', v_joined, 'duplicates', v_dup, 'invalid', v_bad, 'source', p_source, 'batch', p_batch));
  perform public.sales_fill_gaps(p_org);
  return jsonb_build_object('inserted', v_ins, 'joined', v_joined, 'duplicates', v_dup, 'invalid', v_bad);
end $function$;;

-- Every hour, for every company with sales.
select cron.unschedule('sales-gap-fill') where exists (select 1 from cron.job where jobname = 'sales-gap-fill');
select cron.schedule('sales-gap-fill', '23 * * * *', $c$select public.sales_fill_gaps(org_id) from (select distinct org_id from public.sales) x$c$);
select public.sales_fill_gaps(org_id) from (select distinct org_id from public.sales) x;
