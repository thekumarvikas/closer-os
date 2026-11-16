-- Buyers, the way the owner's master sheet works (Nov 2026):
--  · one row = one PAYMENT; rows of the same buyer + program are joined into one ORDER (Price Point = order value)
--  · "Live Webinar …" = bought on their own in the webinar (credited to the webinar); "Sales Team …" → Team Member Name
--  · the enrolment batch (Batch No.) and the webinar attended (Webinar Date) are both kept on the sale
--  · amounts include GST (company setting sales.gst_pct): revenue is shown without GST, collected with GST
--  · international buyers: the Country column gives the calling code when a number has none
--  · sheet rows carry a stable "Closer OS ID": editing a row UPDATES its payment; a row removed from the sheet is flagged
--  · every sale can be edited and deleted by managers.

alter table public.sales add column if not exists enrol_batch text;                                   -- "Batch 12" (the cohort they join)
alter table public.sales add column if not exists webinar_batch_id uuid references public.batches(id) on delete set null;
alter table public.sales add column if not exists webinar_on date;                                    -- webinar attended, as given in the sheet
alter table public.sales add column if not exists sale_channel text;                                  -- webinar | team
alter table public.sales add column if not exists country text;
alter table public.sale_payments add column if not exists row_key text;
alter table public.sale_payments add column if not exists row_hash text;
alter table public.sale_payments add column if not exists source_id uuid references public.buyer_sources(id) on delete set null;
alter table public.sale_payments add column if not exists import_id uuid references public.buyer_imports(id) on delete set null;
alter table public.sale_payments add column if not exists removed_at timestamptz;                     -- row no longer in the sheet
alter table public.sale_payments add column if not exists part_full text;
create unique index if not exists sale_payments_row_key on public.sale_payments (org_id, row_key) where row_key is not null;
create index if not exists sales_webinar on public.sales (webinar_batch_id) where webinar_batch_id is not null;

-- Calling code for a country written in words ("India", "UAE", "United States").
create or replace function public.country_dial_code(c text) returns text language sql immutable as $$
  select case
    when x in ('india', 'in', 'ind', 'bharat') then '+91'
    when x in ('uae', 'united arab emirates', 'dubai', 'abu dhabi', 'sharjah', 'ae') then '+971'
    when x in ('usa', 'us', 'united states', 'united states of america', 'america', 'canada', 'ca') then '+1'
    when x in ('uk', 'united kingdom', 'england', 'great britain', 'britain', 'gb', 'scotland') then '+44'
    when x in ('australia', 'au', 'aus') then '+61'
    when x in ('pakistan', 'pk') then '+92'
    when x in ('nepal', 'np') then '+977'
    when x in ('bangladesh', 'bd') then '+880'
    when x in ('sri lanka', 'srilanka', 'lk') then '+94'
    when x in ('saudi arabia', 'saudi', 'ksa', 'sa') then '+966'
    when x in ('qatar', 'qa') then '+974'
    when x in ('oman', 'om') then '+968'
    when x in ('kuwait', 'kw') then '+965'
    when x in ('bahrain', 'bh') then '+973'
    when x in ('singapore', 'sg') then '+65'
    when x in ('malaysia', 'my') then '+60'
    when x in ('new zealand', 'nz') then '+64'
    when x in ('germany', 'de') then '+49'
    when x in ('france', 'fr') then '+33'
    when x in ('ireland', 'ie') then '+353'
    when x in ('netherlands', 'nl') then '+31'
    when x in ('south africa', 'za') then '+27'
    when x in ('nigeria', 'ng') then '+234'
    when x in ('kenya', 'ke') then '+254'
    when x in ('ghana', 'gh') then '+233'
    when x in ('uganda', 'ug') then '+256'
    when x in ('tanzania', 'tz') then '+255'
    when x in ('ethiopia', 'et') then '+251'
    when x in ('egypt', 'eg') then '+20'
    when x in ('bhutan', 'bt') then '+975'
    when x in ('maldives', 'mv') then '+960'
    when x in ('indonesia', 'id') then '+62'
    when x in ('philippines', 'ph') then '+63'
    when x in ('hong kong', 'hk') then '+852'
    when x in ('japan', 'jp') then '+81'
    else null end
  from (select lower(trim(regexp_replace(coalesce(c, ''), '[^A-Za-z ]', '', 'g'))) x) t
$$;

-- Company GST % included in sale amounts (0 = none).
create or replace function public.org_gst_pct(p_org uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select greatest(coalesce(nullif(settings #>> '{sales,gst_pct}', '')::numeric, 0), 0) from public.organizations where id = p_org
$$;

-- Headings of the buyers sheet → our fields (whole words; the most specific first).
create or replace function public.buyer_field_guess(h text) returns text language sql immutable as $$
  select case
    when x ~ 'closer os id' then 'row_id'
    when x ~ '^(s\.?\s*no\.?|sr\.?\s*no\.?|serial|#|year|month|days to convert)' then null
    when x ~ '\m(utr|txn|transaction|reference|ref)\M' or x ~ '(payment|order)\s*id' then 'reference'
    when x ~ 'pending|balance|due' then 'pending'
    when x ~ 'price point|order value|course fee|total fee|full price|\mprice\M' then 'price'
    when x ~ 'webinar' then 'webinar_date'
    when x ~ 'batch' then 'enrol_batch'
    when x ~ 'team member|sales ?person|closer|sold by|counsell?or|\mmember\M' then 'member'
    when x ~ 'direct|sales team|source of sale|sale type' then 'sale_type'
    when x ~ 'part\s*/?\s*full|full\s*/?\s*part|payment type' then 'part_full'
    when x ~ '\m(method|mode|gateway|paid via|paid through)\M' then 'method'
    when x ~ '\m(remark|remarks|comment|comments|note|notes)\M' then 'remark'
    when x ~ '\mcountry\M' then 'country'
    when x ~ '\m(city|location|town)\M' then 'city'
    when x ~ '\mstate\M' then 'state'
    when x ~ '\m(profession|occupation|designation)\M' then 'profession'
    when x ~ '\m(phone|mobile|contact|whatsapp|number|cell|mob)\M' then 'phone'
    when x ~ '\me\s*-?\s*mail' then 'email'
    when x ~ '\m(date|time|timestamp|when|paid on|payment on|purchased on|created)\M' then 'paid_at'
    when x ~ '\m(amount|paid|fee|fees|value|total|revenue|rs|inr)\M' or x like '%₹%' then 'amount'
    when x ~ '\m(product|course|plan|program|programme|package|item|service)\M' then 'product'
    when x ~ '\m(source|channel|via|medium|platform)\M' then 'source'
    when x ~ '\m(name|buyer|customer|student|client)\M' then 'name'
    else null end
  from (select lower(trim(regexp_replace(coalesce(h, ''), '\s+', ' ', 'g'))) x) t
$$;

create or replace function public.pay_method(raw text) returns text language sql immutable as $$
  select case when x = '' then 'other' when x ~ 'razor' then 'razorpay' when x ~ 'upi|gpay|google pay|phonepe|paytm|qr' then 'upi'
    when x ~ 'bank|neft|imps|rtgs|transfer' then 'bank' when x ~ 'cash' then 'cash' when x ~ 'card' then 'card' when x ~ 'cheque|check' then 'cheque' else 'other' end
  from (select lower(coalesce(raw, '')) x) t
$$;

-- Imports buyer rows (one row = one payment). Row fields: name, phone, email, amount, price, paid_at, product, source,
-- reference, webinar_date, enrol_batch, sale_type, member, method, part_full, remark, country, city, state, profession,
-- row_key, row, extra {heading: value}. Returns totals + every problem row with its reason.
create or replace function public.import_buyers_core(p_org uuid, p_rows jsonb, p_kind text, p_name text, p_source uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_tz text; r jsonb; v_import uuid; i int := 0;
  v_phone text; v_raw text; v_email text; v_amount numeric; v_price numeric; v_at timestamptz; v_lead uuid; v_by_phone uuid; v_by_email uuid; v_how text;
  v_key text; v_hash text; v_sale uuid; v_prod text; v_typo text; v_row int; v_pay record; v_new boolean; v_member uuid; v_channel text;
  v_wb uuid; v_won date; v_w record; v_paid numeric; v_dup boolean; v_cc text; k text; v text;
  n_added int := 0; n_pay int := 0; n_updated int := 0; n_matched int := 0; n_unmatched int := 0; n_check int := 0; n_already int := 0; n_confirm int := 0; n_failed int := 0;
  v_problems jsonb := '[]'::jsonb;
begin
  select phone_prefix, coalesce(timezone, 'Asia/Kolkata') into v_prefix, v_tz from public.organizations where id = p_org;
  insert into public.buyer_imports (org_id, kind, name, source_id, created_by) values (p_org, p_kind, p_name, p_source, p_user) returning id into v_import;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1; v_row := coalesce(nullif(r->>'row', '')::int, i);
    -- Numbers typed in a sheet arrive as 9876500011.0 — and the Country column gives the code when the number has none.
    v_raw := regexp_replace(trim(coalesce(r->>'phone', '')), '\.0+$', '');
    v_cc := coalesce(public.country_dial_code(r->>'country'), v_prefix);
    v_phone := public.normalize_phone(nullif(v_raw, ''), v_cc);
    v_email := public.clean_email(r->>'email');
    v_amount := public.parse_amount(r->>'amount');
    v_price := public.parse_amount(r->>'price');
    v_at := public.parse_any_date(r->>'paid_at', v_tz);
    v_prod := nullif(regexp_replace(trim(coalesce(r->>'product', '')), '\s+', ' ', 'g'), '');
    if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'Phone has only ' || length(regexp_replace(v_phone, '\D', '', 'g')) || ' digits: ' || v_raw);
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
      -- Completely empty rows (the sheet's blank lines) are skipped quietly.
      if coalesce(trim(r->>'name'), '') = '' and v_amount is null then i := i - 1; continue; end if;
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

    v_hash := md5(concat_ws('|', v_phone, v_email, v_amount::text, v_price::text, v_at::text, v_prod, r->>'enrol_batch', r->>'webinar_date', r->>'sale_type',
      r->>'member', r->>'method', r->>'part_full', r->>'remark', r->>'reference', r->>'name'));
    v_key := coalesce(nullif(r->>'row_key', ''), 'file:' || md5(concat_ws('|', public.phone_key(v_phone), public.email_key(v_email), v_amount::text, v_at::date::text, lower(coalesce(v_prod, '')))));

    -- Who sold it, which webinar, which lead.
    v_channel := case when lower(coalesce(r->>'sale_type', '')) ~ 'webinar|direct' then 'webinar' when coalesce(r->>'sale_type', r->>'member', '') <> '' then 'team' end;
    v_member := case when v_channel is distinct from 'webinar' then public.member_by_name(p_org, r->>'member') end;
    select * into v_w from public.webinar_parse(r->>'webinar_date', v_tz);
    v_won := (v_w.at at time zone v_tz)::date;
    v_wb := case when v_won is not null then (select b.id from public.batches b where b.org_id = p_org and (b.webinar_at at time zone v_tz)::date = v_won
      order by (b.kind = 'webinar') desc, b.is_archived, b.created_at limit 1) end;
    v_by_phone := case when v_phone is not null then public.find_lead(p_org, v_phone, null) end;
    v_by_email := case when v_email is not null then public.find_lead(p_org, null, v_email) end;
    if v_by_phone is not null and v_by_email is not null and v_by_phone <> v_by_email then v_lead := null; v_how := 'check';
    else v_lead := coalesce(v_by_phone, v_by_email); v_how := case when v_by_phone is not null then 'phone' when v_by_email is not null then 'email' else 'none' end; end if;

    -- The same row again: unchanged = skipped; edited in the sheet = its payment (and order) are updated.
    select p.* into v_pay from public.sale_payments p where p.org_id = p_org and p.row_key = v_key;
    if v_pay.id is not null then
      if v_pay.row_hash is not distinct from v_hash and v_pay.removed_at is null then n_already := n_already + 1; continue; end if;
      begin
        update public.sale_payments set amount = coalesce(nullif(v_amount, 0), amount), paid_at = v_at, method = public.pay_method(r->>'method'),
          reference = nullif(trim(r->>'reference'), ''), note = nullif(trim(r->>'remark'), ''), part_full = nullif(trim(r->>'part_full'), ''),
          row_hash = v_hash, removed_at = null where id = v_pay.id;
        update public.sales s set product = coalesce(v_prod, s.product), amount = greatest(coalesce(v_price, 0), s.amount, 0),
          enrol_batch = coalesce(nullif(trim(r->>'enrol_batch'), ''), s.enrol_batch), webinar_on = coalesce(v_won, s.webinar_on),
          webinar_batch_id = coalesce(v_wb, s.webinar_batch_id), sale_channel = coalesce(v_channel, s.sale_channel),
          credited_to = case when v_channel = 'webinar' then null else coalesce(v_member, s.credited_to) end,
          country = coalesce(nullif(trim(r->>'country'), ''), s.country), updated_at = now(),
          sold_at = (select min(paid_at) from public.sale_payments where sale_id = s.id and kind = 'payment')
        where s.id = v_pay.sale_id;
        n_updated := n_updated + 1;
      exception when others then
        v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', 'Could not update: ' || sqlerrm); n_failed := n_failed + 1;
      end;
      continue;
    end if;

    -- The order this payment belongs to: same buyer + same program, not rejected.
    select s.id into v_sale from public.sales s
    where s.org_id = p_org and s.source = 'import' and s.status <> 'rejected'
      and lower(coalesce(s.product, '')) = lower(coalesce(v_prod, ''))
      and ((v_lead is not null and s.lead_id = v_lead)
        or (v_phone is not null and public.phone_key(s.buyer->>'phone') = public.phone_key(v_phone))
        or (v_email is not null and public.email_key(s.buyer->>'email') = public.email_key(v_email)))
      and coalesce(nullif(trim(r->>'enrol_batch'), ''), coalesce(s.enrol_batch, '')) = coalesce(s.enrol_batch, '')
    order by s.sold_at desc limit 1;
    v_new := v_sale is null;
    begin
      if v_new then
        insert into public.sales (org_id, lead_id, product, amount, sold_at, status, source, claimed_by, credited_to, verified_by, verified_at,
          buyer, import_id, row_key, match_how, enrol_batch, webinar_batch_id, webinar_on, sale_channel, country, note)
        values (p_org, v_lead, v_prod, coalesce(nullif(v_price, 0), v_amount, 0), v_at, 'verified', 'import', p_user,
          case when v_channel = 'webinar' then null else coalesce(v_member, (select l.assigned_to from public.leads l where l.id = v_lead)) end, p_user, now(),
          jsonb_strip_nulls(jsonb_build_object('name', nullif(trim(r->>'name'), ''), 'phone', v_phone, 'email', v_email, 'phone_typed', nullif(v_raw, ''),
            'email_typed', r->>'email', 'source', nullif(trim(r->>'source'), ''), 'row', v_row, 'member', nullif(trim(r->>'member'), ''),
            'sale_type', nullif(trim(r->>'sale_type'), ''), 'city', nullif(trim(r->>'city'), ''), 'profession', nullif(trim(r->>'profession'), ''),
            'extra', case when jsonb_typeof(r->'extra') = 'object' then r->'extra' end,
            'candidates', case when v_how = 'check' then jsonb_build_array(v_by_phone, v_by_email) end)),
          v_import, null, v_how, nullif(trim(r->>'enrol_batch'), ''), v_wb, v_won, v_channel, nullif(trim(r->>'country'), ''), nullif(trim(r->>'remark'), ''))
        returning id into v_sale;
        insert into public.customers (org_id, name, phone, email, product, purchased_at, amount, source, created_by)
        values (p_org, nullif(trim(r->>'name'), ''), v_phone, v_email, coalesce(v_prod, 'Purchase'), v_at, coalesce(nullif(v_price, 0), v_amount), coalesce(nullif(trim(r->>'source'), ''), p_kind), p_user);
        n_added := n_added + 1;
        if v_how = 'check' then n_check := n_check + 1; elsif v_lead is null then n_unmatched := n_unmatched + 1; else n_matched := n_matched + 1; end if;
      else
        update public.sales s set amount = greatest(coalesce(v_price, 0), s.amount), sold_at = least(s.sold_at, v_at),
          enrol_batch = coalesce(s.enrol_batch, nullif(trim(r->>'enrol_batch'), '')), webinar_on = coalesce(s.webinar_on, v_won),
          webinar_batch_id = coalesce(s.webinar_batch_id, v_wb), sale_channel = coalesce(s.sale_channel, v_channel),
          credited_to = coalesce(s.credited_to, case when coalesce(s.sale_channel, v_channel) = 'webinar' then null else v_member end), updated_at = now()
        where s.id = v_sale;
      end if;
      if coalesce(v_amount, 0) > 0 then
        -- The same amount on the same day for this order, from another row: kept, but shown for the admin to check.
        v_dup := exists (select 1 from public.sale_payments p where p.sale_id = v_sale and p.kind = 'payment' and p.amount = v_amount and p.paid_at::date = v_at::date);
        insert into public.sale_payments (org_id, sale_id, amount, method, paid_at, reference, note, added_by, row_key, row_hash, source_id, import_id, part_full)
        values (p_org, v_sale, v_amount, public.pay_method(r->>'method'), v_at, nullif(trim(r->>'reference'), ''),
          coalesce(nullif(trim(r->>'remark'), ''), case when v_dup then 'Possible duplicate payment' end), p_user, v_key, v_hash, p_source, v_import, nullif(trim(r->>'part_full'), ''));
        if not v_new then n_pay := n_pay + 1; end if;
        if v_dup then n_confirm := n_confirm + 1;
          v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'confirm', 'reason', 'Same buyer, same day, same amount is already there — check it on the Sales page (delete one if it is a repeat)');
        end if;
        select coalesce(sum(amount) filter (where kind = 'payment'), 0) into v_paid from public.sale_payments where sale_id = v_sale;
        if v_paid > (select amount from public.sales where id = v_sale) + 1 then
          v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'warning', 'reason', 'Paid more than the price point (' || v_paid || ') — check the amounts');
        end if;
      end if;
    exception when others then
      v_problems := v_problems || jsonb_build_object('row', v_row, 'level', 'failed', 'reason', case when sqlerrm ilike '%locked%' then 'That month is locked on the Sales page' else 'Could not save: ' || sqlerrm end);
      n_failed := n_failed + 1; continue;
    end;
    -- What the sheet knows about the person fills empty lead details; other columns become lead fields.
    if v_lead is not null then
      update public.leads l set profession = coalesce(nullif(l.profession, ''), nullif(trim(r->>'profession'), '')),
        city = coalesce(nullif(l.city, ''), nullif(trim(r->>'city'), '')), state = coalesce(nullif(l.state, ''), nullif(trim(r->>'state'), '')),
        custom = case when jsonb_typeof(r->'extra') = 'object' then
          (select coalesce(jsonb_object_agg(public.lead_key(e.key), e.value), '{}'::jsonb) from jsonb_each_text(r->'extra') e where trim(e.value) <> '' and public.lead_key(e.key) <> '')
            || coalesce(l.custom, '{}'::jsonb) else l.custom end
      where l.id = v_lead;
    end if;
    if jsonb_typeof(r->'extra') = 'object' then
      for k, v in select * from jsonb_each_text(r->'extra') loop
        continue when public.lead_key(k) = '' or trim(coalesce(v, '')) = '';
        insert into public.lead_fields (org_id, key, label, seen_count) values (p_org, public.lead_key(k), left(trim(k), 80), 1)
        on conflict (org_id, key) do update set seen_count = public.lead_fields.seen_count + 1, last_seen = now();
      end loop;
    end if;
  end loop;
  update public.buyer_imports set totals = jsonb_build_object('rows', i, 'added', n_added, 'payments', n_pay, 'updated', n_updated, 'matched', n_matched,
      'unmatched', n_unmatched, 'check', n_check, 'already', n_already, 'confirm', n_confirm, 'failed', n_failed), problems = v_problems
  where id = v_import;
  return jsonb_build_object('import_id', v_import, 'rows', i, 'added', n_added, 'payments', n_pay, 'updated', n_updated, 'matched', n_matched,
    'unmatched', n_unmatched, 'check', n_check, 'already', n_already, 'confirm', n_confirm, 'failed', n_failed, 'problems', v_problems);
end $$;
revoke execute on function public.import_buyers_core(uuid, jsonb, text, text, uuid, uuid) from anon, public, authenticated;

-- The Google Sheet pushes its rows here (free Apps Script). p_headers = heading row, p_rows = arrays of cell values.
-- A "Closer OS ID" column (written by the script) identifies each row for good, so edits update and nothing doubles.
-- p_ids = every Closer OS ID now in the sheet: rows that disappeared are flagged (never deleted by themselves).
drop function if exists public.buyer_sheet_push(text, jsonb, jsonb, int, text);
create or replace function public.buyer_sheet_push(p_token text, p_headers jsonb, p_rows jsonb, p_first_row int default 2, p_sheet text default null, p_ids jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.buyer_sources; m jsonb; h text; idx int; f text; mapped jsonb := '[]'::jsonb; r jsonb; o jsonb; res jsonb; k text; n int := 0;
  id_idx int; extra jsonb; n_removed int := 0;
begin
  select * into s from public.buyer_sources where token = p_token and is_active;
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'Unknown or paused buyers sheet'); end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then return jsonb_build_object('ok', false, 'error', 'Send at most 5,000 rows at a time'); end if;
  m := '{}'::jsonb;
  for idx in 0 .. jsonb_array_length(coalesce(p_headers, '[]'::jsonb)) - 1 loop
    h := p_headers->>idx;
    if lower(trim(h)) = 'closer os id' then id_idx := idx; continue; end if;
    select key into f from jsonb_each_text(s.field_map) where value = h limit 1;
    f := coalesce(f, case when not (s.field_map ? public.buyer_field_guess(h)) then public.buyer_field_guess(h) end);
    if f is not null and f <> 'row_id' and not (m ? f) then m := m || jsonb_build_object(f, idx); end if;
    f := null;
  end loop;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'array' or not exists (select 1 from jsonb_array_elements_text(r) with ordinality v(val, ord) where trim(val) <> '' and ord - 1 is distinct from id_idx) then n := n + 1; continue; end if;
    o := jsonb_build_object('row', p_first_row + n);
    for k in select * from jsonb_object_keys(m) loop o := o || jsonb_build_object(k, r->>((m->>k)::int)); end loop;
    -- Columns we don't use ourselves (e.g. "Engineering field") travel along and become lead fields.
    select coalesce(jsonb_object_agg(p_headers->>(ord - 1)::int, val), '{}'::jsonb) into extra
    from jsonb_array_elements_text(r) with ordinality v(val, ord)
    where trim(coalesce(val, '')) <> '' and (ord - 1) is distinct from id_idx and coalesce(trim(p_headers->>(ord - 1)::int), '') <> ''
      and not exists (select 1 from jsonb_each_text(m) mm where mm.value::int = ord - 1)
      and public.buyer_field_guess(p_headers->>(ord - 1)::int) is distinct from 'row_id'
      and lower(p_headers->>(ord - 1)::int) !~ '^(s\.?\s*no\.?|sr\.?\s*no\.?|serial|#|year|month|days to convert|pending)';
    o := o || jsonb_build_object('extra', extra, 'row_key', 'sheet:' || s.id || ':' ||
      coalesce(nullif(trim(case when id_idx is not null then r->>id_idx end), ''), md5(r::text)));
    if not (o ? 'source') then o := o || jsonb_build_object('source', coalesce(p_sheet, s.name)); end if;
    mapped := mapped || o; n := n + 1;
  end loop;
  res := public.import_buyers_core(s.org_id, mapped, 'sheet', coalesce(p_sheet, s.name), s.id, s.created_by);
  -- Rows that are no longer in the sheet: flagged for the manager to confirm.
  if p_ids is not null and jsonb_typeof(p_ids) = 'array' and jsonb_array_length(p_ids) > 0 then
    update public.sale_payments p set removed_at = now()
    where p.source_id = s.id and p.removed_at is null and p.row_key is not null
      and not exists (select 1 from jsonb_array_elements_text(p_ids) x where 'sheet:' || s.id || ':' || x = p.row_key)
      and p.row_key ~ ('^sheet:' || s.id || ':[0-9a-f]{8}-');
    get diagnostics n_removed = row_count;
  end if;
  update public.buyer_sources set last_push_at = now(), headers = p_headers, rows_seen = jsonb_array_length(p_rows),
    last_result = res - 'problems' || jsonb_build_object('removed', n_removed, 'problems', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(res->'problems') x limit 100) t))
  where id = s.id;
  return jsonb_build_object('ok', true, 'removed', n_removed) || (res - 'problems') || jsonb_build_object('mapped', m);
end $$;
revoke execute on function public.buyer_sheet_push(text, jsonb, jsonb, int, text, jsonb) from public;
grant execute on function public.buyer_sheet_push(text, jsonb, jsonb, int, text, jsonb) to anon, authenticated;

-- ───── Edit / delete any sale and payment (managers) ─────
create or replace function public.update_sale(p_sale uuid, p jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can edit sales'; end if;
  update public.sales set
    product = case when p ? 'product' then nullif(trim(p->>'product'), '') else product end,
    amount = coalesce(nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, amount),
    sold_at = coalesce(nullif(p->>'sold_at', '')::timestamptz, sold_at),
    credited_to = case when p ? 'credited_to' then nullif(p->>'credited_to', '')::uuid else credited_to end,
    enrol_batch = case when p ? 'enrol_batch' then nullif(trim(p->>'enrol_batch'), '') else enrol_batch end,
    webinar_batch_id = case when p ? 'webinar_batch_id' then nullif(p->>'webinar_batch_id', '')::uuid else webinar_batch_id end,
    sale_channel = case when p ? 'sale_channel' then nullif(p->>'sale_channel', '') else sale_channel end,
    note = case when p ? 'note' then nullif(trim(p->>'note'), '') else note end,
    updated_at = now()
  where id = p_sale;
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data) values (s.org_id, auth.uid(), 'sale.edited', 'sale', p_sale::text, p);
end $$;

create or replace function public.delete_sale(p_sale uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can delete sales'; end if;
  delete from public.sale_payments where sale_id = p_sale;
  delete from public.sales where id = p_sale;
  if s.lead_id is not null then perform public.refresh_lead_stats(s.lead_id); end if;
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
  values (s.org_id, auth.uid(), 'sale.deleted', 'sale', p_sale::text, jsonb_build_object('amount', s.amount, 'product', s.product, 'lead_id', s.lead_id, 'buyer', s.buyer));
end $$;

create or replace function public.update_sale_payment(p_id uuid, p jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare pm public.sale_payments;
begin
  select * into pm from public.sale_payments where id = p_id;
  if pm.id is null or not public.is_org_manager(pm.org_id) then raise exception 'Only managers can edit payments'; end if;
  if coalesce((p->>'keep')::boolean, false) then update public.sale_payments set removed_at = null, row_key = null where id = p_id; return; end if;
  update public.sale_payments set
    amount = coalesce(nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, amount),
    paid_at = coalesce(nullif(p->>'paid_at', '')::timestamptz, paid_at),
    method = coalesce(nullif(p->>'method', ''), method),
    reference = case when p ? 'reference' then nullif(trim(p->>'reference'), '') else reference end
  where id = p_id;
end $$;

revoke execute on function public.update_sale(uuid, jsonb) from anon, public;
revoke execute on function public.delete_sale(uuid) from anon, public;
revoke execute on function public.update_sale_payment(uuid, jsonb) from anon, public;
grant execute on function public.update_sale(uuid, jsonb) to authenticated;
grant execute on function public.delete_sale(uuid) to authenticated;
grant execute on function public.update_sale_payment(uuid, jsonb) to authenticated;
grant execute on function public.country_dial_code(text) to authenticated;
grant execute on function public.org_gst_pct(uuid) to authenticated;
grant execute on function public.pay_method(text) to authenticated;

-- Payments imported before this change keep their row's identity, so sending the same rows again adds nothing.
update public.sale_payments p set row_key = case when s.row_key like 'sheet:%' then s.row_key else 'file:' || s.row_key end, import_id = s.import_id,
  source_id = (select bi.source_id from public.buyer_imports bi where bi.id = s.import_id)
from public.sales s
where s.id = p.sale_id and s.source = 'import' and s.row_key is not null and p.row_key is null and p.kind = 'payment'
  and p.id = (select p2.id from public.sale_payments p2 where p2.sale_id = s.id and p2.kind = 'payment' order by p2.created_at limit 1)
  and not public.sale_month_locked(p.org_id, p.paid_at);
