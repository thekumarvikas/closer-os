-- Rule: every lead with a webinar date joins that webinar; every sale knows the webinar its buyer registered for.

-- Join the webinar named in a lead's "Webinar Date" text (created if missing). Registration, not attendance.
create or replace function public.lead_join_webinar(p_lead uuid, p_raw text, p_source uuid default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare l record; v_b uuid;
begin
  select id, org_id, custom, coalesce(signup_at, created_at) su into l from public.leads where id = p_lead;
  p_raw := coalesce(nullif(trim(p_raw), ''), nullif(trim(l.custom->>'webinar_date'), ''));
  if l.id is null or p_raw is null then return null; end if;
  v_b := public.batch_for_text(l.org_id, p_raw, p_source, l.su);
  if v_b is null then return null; end if;
  insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, attended, registered)
  values (v_b, p_lead, l.org_id, false, false, true)
  on conflict (batch_id, lead_id) do update set registered = true;
  return v_b;
end $$;
revoke all on function public.lead_join_webinar(uuid, text, uuid) from public, anon, authenticated;

-- The webinar a sale belongs to: the latest one the buyer registered for (or joined) up to the day after the sale.
alter table public.sales add column if not exists webinar_auto boolean not null default false;

create or replace function public.sale_webinar_pick(p_lead uuid, p_sold timestamptz)
returns uuid language sql stable security definer set search_path to '' as $$
  select b.id from public.batch_leads bl join public.batches b on b.id = bl.batch_id
  where bl.lead_id = p_lead and b.webinar_at <= p_sold + interval '1 day'
  order by b.webinar_at desc limit 1
$$;

create or replace function public.t_sale_webinar() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.lead_id is not null and (new.webinar_batch_id is null or new.webinar_auto) then
    new.webinar_batch_id := public.sale_webinar_pick(new.lead_id, coalesce(new.sold_at, now()));
    new.webinar_auto := new.webinar_batch_id is not null;
  end if;
  return new;
end $$;
drop trigger if exists t_sale_webinar on public.sales;
create trigger t_sale_webinar before insert or update of lead_id, sold_at, webinar_batch_id on public.sales
  for each row execute function public.t_sale_webinar();

-- A registration added later (Zoom report, sheet, import) re-checks that lead's sales.
create or replace function public.t_bl_sale_webinar() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  update public.sales set webinar_batch_id = null where lead_id = new.lead_id and (webinar_batch_id is null or webinar_auto);
  return null;
end $$;
drop trigger if exists t_bl_sale_webinar on public.batch_leads;
create trigger t_bl_sale_webinar after insert on public.batch_leads for each row execute function public.t_bl_sale_webinar();

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
        perform public.lead_join_webinar(v_existing, r->>'webinar_date', null);
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
    if p_batch is null then perform public.lead_join_webinar(v_new, r->>'webinar_date', null); end if;
    if p_batch is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes, attended, registered)
      values (p_batch, v_new, p_org, false, v_minutes, coalesce(v_minutes, 0) > 0, v_reg);
    end if;
    v_ins := v_ins + 1;
  end loop;

  perform set_config('closeros.skip_distribution', 'off', true);
  perform public.write_audit(p_org, 'leads.imported', 'lead', null,
    jsonb_build_object('inserted', v_ins, 'joined_batch', v_joined, 'duplicates', v_dup, 'invalid', v_bad, 'source', p_source, 'batch', p_batch));
  return jsonb_build_object('inserted', v_ins, 'joined', v_joined, 'duplicates', v_dup, 'invalid', v_bad);
end $function$;

-- Leads already imported with a webinar date: join their webinar.
do $$ declare r record; begin
  for r in select l.id from public.leads l
    where l.deleted_at is null and nullif(trim(l.custom->>'webinar_date'), '') is not null
      and not exists (select 1 from public.batch_leads bl where bl.lead_id = l.id)
  loop perform public.lead_join_webinar(r.id, null); end loop;
end $$;

-- Sign-up times that landed after the lead's own webinar: read the date again with the webinar as the guide.
update public.leads l set signup_at = g.t
from (select l2.id, public.signup_guess(coalesce(l2.custom->>'date', l2.custom->>'timestamp', l2.custom->>'date_time'),
        coalesce(o.timezone, 'Asia/Kolkata'), l2.created_at, w.at) t
      from public.leads l2 join public.organizations o on o.id = l2.org_id
      join lateral (select min(b.webinar_at) at from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = l2.id) w on true
      where w.at is not null and l2.signup_at > w.at + interval '1 day' and l2.signup_at < l2.created_at - interval '1 minute') g
where g.id = l.id and g.t is not null and g.t <> l.signup_at;

-- Every sale: pick its webinar.
update public.sales set webinar_batch_id = null where lead_id is not null and (webinar_batch_id is null or webinar_auto);
