-- Round 15 · 1c) The app's own file import had the same growing-array duplicate check
-- as the dashboard import: every row was compared against every row before it. A temp
-- table with a unique key is flat. Behaviour is unchanged.

CREATE OR REPLACE FUNCTION public.import_my_leads(p_org uuid, p_rows jsonb, p_batch uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prefix text; r jsonb; v_phone text; v_id uuid; v_n int;
        v_ins int := 0; v_already int := 0; v_bad int := 0; v_joined int := 0; v_ids uuid[] := '{}';
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_batch is not null and not exists (select 1 from public.batches where id = p_batch and org_id = p_org) then raise exception 'Unknown event'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  perform set_config('closeros.skip_distribution', 'on', true);

  create temp table if not exists _app_seen (phone text primary key) on commit drop;
  truncate pg_temp._app_seen;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;

    insert into pg_temp._app_seen (phone) values (v_phone) on conflict do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then v_already := v_already + 1; continue; end if;

    v_id := public.find_lead(p_org, v_phone, r->>'email');
    if v_id is not null then
      v_already := v_already + 1;
      -- Leads already in the list still go into "call / message these now" when this person can work them.
      if public.lead_visible(v_id) then
        v_ids := v_ids || v_id;
        -- the file's tag (e.g. "Pune list · 16 Nov") goes on leads already in the list too
        if nullif(trim(r->>'tag'), '') is not null then
          update public.leads set tags = (select array_agg(distinct t) from unnest(coalesce(tags, '{}') || trim(r->>'tag')) t), updated_at = now() where id = v_id;
        end if;
      end if;
      perform public.lead_arrived(v_id, 'app', coalesce(nullif(trim(r->>'source'), ''), p_source, 'Imported in app'), nullif(trim(r->>'campaign'), ''), p_batch, r);
      if p_batch is not null then
        insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_id, p_org, true) on conflict do nothing;
        if found then v_joined := v_joined + 1; update public.leads set updated_at = now() where id = v_id; end if;
      end if;
      continue;
    end if;
    insert into public.leads (org_id, name, phone, email, city, state, profession, company, notes, source, campaign, assigned_to, tags)
    values (p_org, coalesce(trim(r->>'name'), ''), v_phone, nullif(lower(trim(r->>'email')), ''), nullif(trim(r->>'city'), ''),
      nullif(trim(r->>'state'), ''), nullif(trim(r->>'profession'), ''), nullif(trim(r->>'company'), ''), nullif(trim(r->>'notes'), ''),
      coalesce(nullif(trim(r->>'source'), ''), p_source, 'Imported in app'), nullif(trim(r->>'campaign'), ''), auth.uid(),
      case when nullif(trim(r->>'tag'), '') is not null then array[trim(r->>'tag')] else '{}' end)
    returning id into v_id;
    if p_batch is not null then insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_id, p_org, false) on conflict do nothing; end if;
    v_ins := v_ins + 1;
    v_ids := v_ids || v_id;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'already', v_already, 'joined', v_joined, 'invalid', v_bad, 'ids', to_jsonb(v_ids));
end $function$;
