-- Buyer Analysis (Nov 2026) — admin/manager only.
-- 1 Import buyers (CSV upload or a connected Google Sheet that pushes its rows), cleaned and de-duplicated.
--   Every buyer = a VERIFIED sale (source 'import') with its payment; the matching lead is marked bought (won_at).
-- 2 Match to leads: phone (exact with country code, or last 10 digits) OR email (cleaned, provider typos fixed).
--   Phone → lead A but email → lead B = "please check". No match = "unmatched" (link by hand).
-- 3 Effort per sale, 4 pattern finder, 5 gaps — reporting functions further below.

-- ───── Clean values ─────
-- Amount like "₹1,23,000.50" / "Rs. 999" / "1 999" → number.
create or replace function public.parse_amount(raw text) returns numeric language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(raw, ''), '[^0-9.]', '', 'g');
begin
  if d = '' or d = '.' then return null; end if;
  if d ~ '\..*\.' then d := regexp_replace(d, '\.(?=.*\.)', '', 'g'); end if;   -- 1.234.567 → 1234567
  return d::numeric;
exception when others then return null;
end $$;

-- Dates as people type them: 14/11/2026, 14-11-2026 10:30, 2026-11-14, 14 Nov 2026, Nov 14, 2026, Excel day numbers.
-- Day first (India) unless the first number can't be a day... month (> 12). Missing time = noon in the company's time zone.
create or replace function public.parse_any_date(raw text, tz text default 'Asia/Kolkata') returns timestamptz
language plpgsql stable as $$
declare s text := trim(coalesce(raw, '')); m text[]; d int; mo int; y int; hh int := 12; mi int := 0; ss int := 0; pm text; mon text;
  months text[] := array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
begin
  if s = '' then return null; end if;
  -- Excel serial day number (e.g. 46340 or 46340.5)
  if s ~ '^\d{5}(\.\d+)?$' then return (timestamp '1899-12-30' + (s::numeric * interval '1 day')) at time zone tz; end if;
  -- ISO 2026-11-14 / 2026-11-14T10:30:00Z / with offset
  if s ~ '^\d{4}-\d{1,2}-\d{1,2}' then
    if s ~ '(Z|[+-]\d{2}:?\d{2})$' then return s::timestamptz; end if;
    return (replace(s, 'T', ' ')::timestamp) at time zone tz;
  end if;
  m := regexp_match(s, '^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?');
  if m is not null then
    d := m[1]::int; mo := m[2]::int; y := m[3]::int; if y < 100 then y := 2000 + y; end if;
    if mo > 12 and d <= 12 then mo := m[1]::int; d := m[2]::int; end if;      -- US order 11/14/2026
    if m[4] is not null then hh := m[4]::int; mi := m[5]::int; ss := coalesce(m[6]::int, 0); pm := lower(m[7]);
      if pm = 'pm' and hh < 12 then hh := hh + 12; elsif pm = 'am' and hh = 12 then hh := 0; end if; end if;
    return make_timestamptz(y, mo, d, hh, mi, ss, tz);
  end if;
  -- 14 Nov 2026 / 14-Nov-26 / Nov 14, 2026
  m := regexp_match(lower(s), '^(\d{1,2})[ \-/]?([a-z]{3})[a-z]*[ \-/,]*(\d{2,4})');
  if m is not null then
    mon := m[2]; mo := array_position(months, mon); d := m[1]::int; y := m[3]::int;
  else
    m := regexp_match(lower(s), '^([a-z]{3})[a-z]*[ \-/]*(\d{1,2})(?:st|nd|rd|th)?[ ,\-/]*(\d{2,4})');
    if m is null then return null; end if;
    mo := array_position(months, m[1]); d := m[2]::int; y := m[3]::int;
  end if;
  if mo is null then return null; end if;
  if y < 100 then y := 2000 + y; end if;
  return make_timestamptz(y, mo, d, 12, 0, 0, tz);
exception when others then return null;
end $$;

-- ───── Imports and the Google Sheet connection ─────
create table if not exists public.buyer_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'csv',               -- csv | sheet
  name text,
  source_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  totals jsonb not null default '{}'::jsonb,
  problems jsonb not null default '[]'::jsonb      -- failed rows + warnings (row, reason)
);
create index if not exists buyer_imports_org on public.buyer_imports (org_id, created_at desc);
alter table public.buyer_imports enable row level security;
drop policy if exists buyer_imports_select on public.buyer_imports;
create policy buyer_imports_select on public.buyer_imports for select using (public.is_org_manager(org_id));

create table if not exists public.buyer_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default 'Buyers sheet',
  token text not null unique default encode(gen_random_bytes(18), 'hex'),
  field_map jsonb not null default '{}'::jsonb,    -- our field → sheet column heading
  headers jsonb,                                   -- headings seen in the last push
  is_active boolean not null default true,
  last_push_at timestamptz, last_result jsonb, rows_seen int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.buyer_sources enable row level security;
drop policy if exists buyer_sources_select on public.buyer_sources;
create policy buyer_sources_select on public.buyer_sources for select using (public.is_org_manager(org_id));

alter table public.sales add column if not exists import_id uuid references public.buyer_imports(id) on delete set null;
alter table public.sales add column if not exists row_key text;           -- same sheet / file row sent again = skipped
alter table public.sales add column if not exists match_how text;         -- phone | email | manual | check | none
alter table public.sales add column if not exists dup_of uuid references public.sales(id) on delete set null;
create unique index if not exists sales_row_key on public.sales (org_id, row_key) where row_key is not null;
create index if not exists sales_unmatched on public.sales (org_id) where source = 'import' and lead_id is null;

-- Guess which of our fields a heading is.
create or replace function public.buyer_field_guess(h text) returns text language sql immutable as $$
  -- Whole words only ("Course" must not match "rs").
  select case
    when x ~ '\m(utr|txn|transaction|reference|ref|razorpay)\M' or x ~ '(payment|order)\s*id' then 'reference'
    when x ~ '\m(phone|mobile|contact|whatsapp|number|cell|mob)\M' then 'phone'
    when x ~ '\me\s*-?\s*mail' then 'email'
    when x ~ '\m(date|time|timestamp|when|paid on|payment on|purchased on|created)\M' then 'paid_at'
    when x ~ '\m(amount|price|paid|fee|fees|value|total|revenue|rs|inr)\M' or x like '%₹%' then 'amount'
    when x ~ '\m(product|course|plan|program|programme|package|item|batch|service)\M' then 'product'
    when x ~ '\m(source|channel|via|medium|platform)\M' then 'source'
    when x ~ '\m(name|buyer|customer|student|client)\M' then 'name'
    else null end
  from (select lower(coalesce(h, '')) x) t
$$;

-- Imports buyer rows. Each row: {name, phone, email, amount, paid_at, product, source, reference, row_key, row}.
-- Never replaces or deletes earlier buyers. Returns totals + every problem row with its reason.
create or replace function public.import_buyers_core(p_org uuid, p_rows jsonb, p_kind text, p_name text, p_source uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_tz text; v_cur text; r jsonb; v_import uuid; i int := 0;
  v_phone text; v_email text; v_amount numeric; v_at timestamptz; v_lead uuid; v_by_phone uuid; v_by_email uuid; v_how text;
  v_key text; v_dup uuid; v_sale uuid; v_prod text; v_typo text; v_row int;
  n_added int := 0; n_matched int := 0; n_unmatched int := 0; n_check int := 0; n_already int := 0; n_confirm int := 0; n_failed int := 0;
  v_problems jsonb := '[]'::jsonb;
begin
  select phone_prefix, timezone, currency into v_prefix, v_tz, v_cur from public.organizations where id = p_org;
  insert into public.buyer_imports (org_id, kind, name, source_id, created_by) values (p_org, p_kind, p_name, p_source, p_user) returning id into v_import;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1; v_row := coalesce(nullif(r->>'row', '')::int, i);
    v_phone := public.normalize_phone(nullif(trim(r->>'phone'), ''), v_prefix);
    v_email := public.clean_email(r->>'email');
    v_amount := public.parse_amount(r->>'amount');
    v_at := public.parse_any_date(r->>'paid_at', v_tz);
    v_prod := nullif(regexp_replace(trim(coalesce(r->>'product', '')), '\s+', ' ', 'g'), '');
    -- Problems that stop the row.
    if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 8 then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'Phone has only ' || length(regexp_replace(v_phone, '\D', '', 'g')) || ' digits: ' || coalesce(r->>'phone', ''));
      n_failed := n_failed + 1; continue;
    end if;
    if v_email is not null and (position('@' in v_email) < 2 or v_email !~ '@[^@]+\.[^@]+$') then
      if v_phone is null then
        v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'Email has no @ or no domain: ' || coalesce(r->>'email', ''));
        n_failed := n_failed + 1; continue;
      end if;
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'warning', 'reason', 'Email looks wrong (ignored): ' || coalesce(r->>'email', ''));
      v_email := null;
    end if;
    if v_phone is null and v_email is null then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'No phone number and no email');
      n_failed := n_failed + 1; continue;
    end if;
    if nullif(trim(r->>'amount'), '') is not null and v_amount is null then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'Amount is not a number: ' || (r->>'amount'));
      n_failed := n_failed + 1; continue;
    end if;
    if nullif(trim(r->>'paid_at'), '') is not null and v_at is null then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'Payment date not understood: ' || (r->>'paid_at') || ' (use e.g. 14/11/2026)');
      n_failed := n_failed + 1; continue;
    end if;
    -- Warnings (row still imported).
    if v_email is not null then
      v_typo := public.email_domain_fix(split_part(v_email, '@', 2));
      if v_typo is not null then
        v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'warning', 'reason', 'Email may be misspelt: ' || v_email || ' — did you mean ' || split_part(v_email, '@', 1) || '@' || v_typo || '? (matched using the right spelling)');
      end if;
    end if;
    if v_at is null then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'warning', 'reason', 'No payment date — today''s date used');
      v_at := now();
    end if;

    -- The same row sent again (sheet re-sync / same file again): skip quietly.
    v_key := coalesce(nullif(r->>'row_key', ''), md5(concat_ws('|', public.phone_key(v_phone), public.email_key(v_email), v_amount::text, v_at::date::text, lower(coalesce(v_prod, '')))));
    if exists (select 1 from public.sales where org_id = p_org and row_key = v_key) then n_already := n_already + 1; continue; end if;

    -- Match: phone (exact or last 10 digits) and email (cleaned, typos fixed).
    v_by_phone := case when v_phone is not null then public.find_lead(p_org, v_phone, null) end;
    v_by_email := case when v_email is not null then public.find_lead(p_org, null, v_email) end;
    if v_by_phone is not null and v_by_email is not null and v_by_phone <> v_by_email then v_lead := null; v_how := 'check';
    else v_lead := coalesce(v_by_phone, v_by_email); v_how := case when v_by_phone is not null then 'phone' when v_by_email is not null then 'email' else 'none' end; end if;

    -- Possible duplicate: same buyer, same day, same amount, already imported with other details → admin confirms.
    select s.id into v_dup from public.sales s where s.org_id = p_org and s.source = 'import' and s.status <> 'rejected'
      and s.sold_at::date = v_at::date and s.amount = coalesce(v_amount, 0)
      and ((v_phone is not null and public.phone_key(s.buyer->>'phone') = public.phone_key(v_phone))
        or (v_email is not null and public.email_key(s.buyer->>'email') = public.email_key(v_email)))
      limit 1;

    insert into public.sales (org_id, lead_id, product, amount, sold_at, status, source, claimed_by, credited_to, verified_by, verified_at,
      buyer, import_id, row_key, match_how, dup_of, note)
    values (p_org, v_lead, v_prod, coalesce(v_amount, 0), v_at, case when v_dup is null then 'verified' else 'claimed' end, 'import',
      p_user, (select l.assigned_to from public.leads l where l.id = v_lead), p_user, case when v_dup is null then now() end,
      jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(r->>'name'), ''), 'phone', v_phone, 'email', v_email, 'phone_typed', r->>'phone',
        'email_typed', r->>'email', 'source', nullif(trim(r->>'source'), ''), 'reference', nullif(trim(r->>'reference'), ''), 'row', v_row,
        'candidates', case when v_how = 'check' then jsonb_build_array(v_by_phone, v_by_email) end)),
      v_import, v_key, v_how, v_dup,
      case when v_dup is not null then 'Possible duplicate: same buyer, same day, same amount already imported' end)
    returning id into v_sale;
    -- The buyers list means paid: record the payment.
    if coalesce(v_amount, 0) > 0 then
      insert into public.sale_payments (org_id, sale_id, amount, method, paid_at, reference, note, added_by)
      values (p_org, v_sale, v_amount, 'other', v_at, nullif(trim(r->>'reference'), ''), 'From the buyers list', p_user);
    end if;
    -- Old buyers list (webinar reports use it).
    insert into public.customers (org_id, name, phone, email, product, purchased_at, amount, source, created_by)
    values (p_org, nullif(trim(r->>'name'), ''), v_phone, v_email, coalesce(v_prod, 'Purchase'), v_at, v_amount, coalesce(nullif(trim(r->>'source'), ''), p_kind), p_user);
    if v_dup is not null then n_confirm := n_confirm + 1;
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'confirm', 'reason', 'Same buyer, same day, same amount was imported before — confirm or reject it on the Sales page (To verify)');
    else n_added := n_added + 1; end if;
    if v_how = 'check' then n_check := n_check + 1; elsif v_lead is null then n_unmatched := n_unmatched + 1; else n_matched := n_matched + 1; end if;
  end loop;
  update public.buyer_imports set totals = jsonb_build_object('rows', i, 'added', n_added, 'matched', n_matched, 'unmatched', n_unmatched,
      'check', n_check, 'already', n_already, 'confirm', n_confirm, 'failed', n_failed), problems = v_problems
  where id = v_import;
  return jsonb_build_object('import_id', v_import, 'rows', i, 'added', n_added, 'matched', n_matched, 'unmatched', n_unmatched, 'check', n_check,
    'already', n_already, 'confirm', n_confirm, 'failed', n_failed, 'problems', v_problems);
end $$;

-- CSV upload from the dashboard (rows already mapped to our fields).
create or replace function public.import_buyers(p_org uuid, p_rows jsonb, p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can import buyers'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  return public.import_buyers_core(p_org, p_rows, 'csv', p_name, null, auth.uid());
end $$;

-- The Google Sheet pushes its rows here (free Apps Script, no paid tool). Public endpoint, checked by the secret token.
-- p_headers = the sheet's heading row, p_rows = arrays of cell values (same order), p_first_row = sheet row number of p_rows[0].
create or replace function public.buyer_sheet_push(p_token text, p_headers jsonb, p_rows jsonb, p_first_row int default 2, p_sheet text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.buyer_sources; m jsonb; h text; idx int; f text; mapped jsonb := '[]'::jsonb; r jsonb; o jsonb; res jsonb; k text; n int := 0;
begin
  select * into s from public.buyer_sources where token = p_token and is_active;
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'Unknown or paused buyers sheet'); end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then return jsonb_build_object('ok', false, 'error', 'Send at most 5,000 rows at a time'); end if;
  -- Column map: saved choices first, else guessed from the headings.
  m := '{}'::jsonb;
  for idx in 0 .. jsonb_array_length(coalesce(p_headers, '[]'::jsonb)) - 1 loop
    h := p_headers->>idx;
    select key into f from jsonb_each_text(s.field_map) where value = h limit 1;
    f := coalesce(f, case when not (s.field_map ? public.buyer_field_guess(h)) then public.buyer_field_guess(h) end);
    if f is not null and not (m ? f) then m := m || jsonb_build_object(f, idx); end if;
    f := null;
  end loop;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'array' or not exists (select 1 from jsonb_array_elements_text(r) v where trim(v) <> '') then n := n + 1; continue; end if;
    o := jsonb_build_object('row', p_first_row + n);
    for k in select * from jsonb_object_keys(m) loop o := o || jsonb_build_object(k, r->>((m->>k)::int)); end loop;
    -- A sheet row is identified by its content, so editing a row re-imports it and an untouched row is skipped.
    o := o || jsonb_build_object('row_key', 'sheet:' || s.id || ':' || md5(r::text));
    if not (o ? 'source') then o := o || jsonb_build_object('source', coalesce(p_sheet, s.name)); end if;
    mapped := mapped || o; n := n + 1;
  end loop;
  res := public.import_buyers_core(s.org_id, mapped, 'sheet', coalesce(p_sheet, s.name), s.id, s.created_by);
  update public.buyer_sources set last_push_at = now(), headers = p_headers, rows_seen = jsonb_array_length(p_rows),
    last_result = res - 'problems' || jsonb_build_object('problems', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(res->'problems') x limit 100) t))
  where id = s.id;
  return jsonb_build_object('ok', true) || (res - 'problems') || jsonb_build_object('mapped', m);
end $$;

-- Managers: make / list / change the sheet connection.
create or replace function public.save_buyer_source(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; res public.buyer_sources;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can connect a buyers sheet'; end if;
  if v_id is null then
    insert into public.buyer_sources (org_id, name, created_by) values (p_org, coalesce(nullif(trim(p->>'name'), ''), 'Buyers sheet'), auth.uid()) returning * into res;
  else
    update public.buyer_sources set name = coalesce(nullif(trim(p->>'name'), ''), name),
      field_map = case when p ? 'field_map' then coalesce(p->'field_map', '{}'::jsonb) else field_map end,
      is_active = coalesce((p->>'is_active')::boolean, is_active)
    where id = v_id and org_id = p_org returning * into res;
  end if;
  return to_jsonb(res);
end $$;

-- ───── 2 Matching ─────
-- Link a buyer to a lead by hand (unmatched / please-check lists). The lead is then marked bought.
create or replace function public.link_buyer(p_sale uuid, p_lead uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can link buyers'; end if;
  if not exists (select 1 from public.leads where id = p_lead and org_id = s.org_id and deleted_at is null) then raise exception 'Lead not found'; end if;
  update public.sales set lead_id = p_lead, match_how = 'manual', credited_to = coalesce(credited_to, (select assigned_to from public.leads where id = p_lead)),
    updated_at = now() where id = p_sale;
  update public.leads set won_at = least(coalesce(won_at, s.sold_at), s.sold_at), updated_at = now() where id = p_lead and s.status = 'verified';
end $$;

-- Try again to match buyers that had no lead (new leads come in all the time). Returns how many got matched.
create or replace function public.rematch_buyers(p_org uuid) returns int language plpgsql security definer set search_path = '' as $$
declare s record; v_p uuid; v_e uuid; n int := 0;
begin
  -- Managers from the dashboard; the daily job runs without a user.
  if auth.uid() is not null and not public.is_org_manager(p_org) then raise exception 'Only managers'; end if;
  for s in select id, buyer from public.sales where org_id = p_org and source = 'import' and lead_id is null and coalesce(match_how, 'none') = 'none' loop
    v_p := case when s.buyer->>'phone' is not null then public.find_lead(p_org, s.buyer->>'phone', null) end;
    v_e := case when s.buyer->>'email' is not null then public.find_lead(p_org, null, s.buyer->>'email') end;
    if v_p is not null and v_e is not null and v_p <> v_e then
      update public.sales set match_how = 'check', buyer = buyer || jsonb_build_object('candidates', jsonb_build_array(v_p, v_e)) where id = s.id;
    elsif coalesce(v_p, v_e) is not null then
      update public.sales set lead_id = coalesce(v_p, v_e), match_how = case when v_p is not null then 'phone' else 'email' end,
        credited_to = coalesce(credited_to, (select assigned_to from public.leads where id = coalesce(v_p, v_e))), updated_at = now() where id = s.id;
      update public.leads l set won_at = least(coalesce(l.won_at, x.sold_at), x.sold_at), updated_at = now()
        from public.sales x where x.id = s.id and l.id = x.lead_id and x.status = 'verified';
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Unmatched + please-check buyers with possible leads (managers).
create or replace function public.buyer_match_lists(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers'; end if;
  return jsonb_build_object(
    'unmatched', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'buyer', s.buyer, 'amount', s.amount, 'product', s.product, 'sold_at', s.sold_at,
        'suggest', (select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email)) from (
          select l.* from public.leads l where l.org_id = p_org and l.deleted_at is null and coalesce(s.buyer->>'name', '') <> ''
            and lower(l.name) like '%' || lower(split_part(trim(s.buyer->>'name'), ' ', 1)) || '%' limit 5) l)) order by s.sold_at desc)
      from public.sales s where s.org_id = p_org and s.source = 'import' and s.lead_id is null and coalesce(s.match_how, 'none') = 'none' and s.status <> 'rejected'), '[]'::jsonb),
    'check', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'buyer', s.buyer, 'amount', s.amount, 'product', s.product, 'sold_at', s.sold_at,
        'candidates', (select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email))
          from public.leads l where l.id in (select (jsonb_array_elements_text(s.buyer->'candidates'))::uuid))) order by s.sold_at desc)
      from public.sales s where s.org_id = p_org and s.source = 'import' and s.lead_id is null and s.match_how = 'check' and s.status <> 'rejected'), '[]'::jsonb));
end $$;

revoke execute on function public.import_buyers_core(uuid, jsonb, text, text, uuid, uuid) from anon, public, authenticated;
revoke execute on function public.import_buyers(uuid, jsonb, text) from anon, public;
revoke execute on function public.buyer_sheet_push(text, jsonb, jsonb, int, text) from public;
revoke execute on function public.save_buyer_source(uuid, jsonb) from anon, public;
revoke execute on function public.link_buyer(uuid, uuid) from anon, public;
revoke execute on function public.rematch_buyers(uuid) from anon, public;
revoke execute on function public.buyer_match_lists(uuid) from anon, public;
grant execute on function public.import_buyers(uuid, jsonb, text) to authenticated;
grant execute on function public.buyer_sheet_push(text, jsonb, jsonb, int, text) to anon, authenticated;
grant execute on function public.save_buyer_source(uuid, jsonb) to authenticated;
grant execute on function public.link_buyer(uuid, uuid) to authenticated;
grant execute on function public.rematch_buyers(uuid) to authenticated;
grant execute on function public.buyer_match_lists(uuid) to authenticated;
grant execute on function public.parse_amount(text) to authenticated;
grant execute on function public.parse_any_date(text, text) to authenticated;
grant execute on function public.buyer_field_guess(text) to authenticated;

-- Every day: match buyers whose lead came in later.
select cron.unschedule('buyers-rematch') where exists (select 1 from cron.job where jobname = 'buyers-rematch');
select cron.schedule('buyers-rematch', '17 2 * * *', $$select public.rematch_buyers(id) from public.organizations$$);
