-- Webinar batches, Zoom attendance, sales vs reminder calls, profession categories, buyers.
--
-- A batch is one webinar (date). Leads join batches (a lead can be in many: "Repeated").
-- Zoom attendance sets each lead's watch minutes in that batch.
-- Calls and outcomes have a purpose: 'sales' (after the webinar) or 'reminder' (before it).
-- A lead can have a separate reminder caller per batch (some companies use a reminder team).
-- Professions are grouped into categories by keywords (e.g. "CA", "insurance" → Finance).
-- Buyers (past customers) are uploaded by management; leads that match are "already enrolled".

-- ───────────────────────── Tables ─────────────────────────
create table public.batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  webinar_at timestamptz not null,
  hot_minutes int not null default 60 check (hot_minutes >= 0),          -- "watched more than X minutes"
  guided_target_pct int not null default 70 check (guided_target_pct between 0 and 100),
  zoom_uploaded_at timestamptz,
  is_archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create index on public.batches (org_id, webinar_at desc);

create table public.batch_leads (
  batch_id uuid not null references public.batches(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  reminder_by uuid references auth.users(id) on delete set null,       -- who makes the reminder calls
  watch_minutes int check (watch_minutes >= 0),                         -- from the Zoom report
  attended boolean not null default false,
  is_repeat boolean not null default false,                             -- was already a lead before this batch
  added_at timestamptz not null default now(),
  primary key (batch_id, lead_id)
);
create index on public.batch_leads (lead_id);
create index on public.batch_leads (org_id, reminder_by);

alter table public.call_outcomes add column purpose text not null default 'sales'
  check (purpose in ('sales', 'reminder', 'both'));
alter table public.calls add column purpose text not null default 'sales' check (purpose in ('sales', 'reminder'));
alter table public.calls add column batch_id uuid references public.batches(id) on delete set null;
create index calls_batch_idx on public.calls (batch_id, lead_id) where batch_id is not null;
alter table public.follow_ups add column purpose text not null default 'sales' check (purpose in ('sales', 'reminder'));

create table public.profession_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  keywords text[] not null default '{}',
  position int not null default 0,
  unique (org_id, name)
);
alter table public.leads add column profession_category_id uuid references public.profession_categories(id) on delete set null;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text,
  phone text,
  email text,
  product text not null,
  purchased_at timestamptz,
  amount numeric(14, 2),
  source text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.customers (org_id, phone);
create index on public.customers (org_id, lower(email));

-- ───────────────────────── Who can see a lead ─────────────────────────
-- Besides the owner/manager/admin rules, a reminder caller can see the leads they must call.
create or replace function public.lead_visible(p_lead uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.leads l
    where l.id = p_lead and (
      public.can_see_lead(l.org_id, l.assigned_to)
      or exists (select 1 from public.batch_leads bl
                 where bl.lead_id = l.id and bl.reminder_by is not null and public.can_see_user(l.org_id, bl.reminder_by))
    )
  )
$$;

drop policy leads_select on public.leads;
create policy leads_select on public.leads for select using (
  public.is_org_member(org_id) and (
    public.can_see_lead(org_id, assigned_to)
    or exists (select 1 from public.batch_leads bl
               where bl.lead_id = leads.id and bl.reminder_by is not null and public.can_see_user(leads.org_id, bl.reminder_by))
  )
);
drop policy leads_update on public.leads;
create policy leads_update on public.leads for update
  using (public.is_org_member(org_id) and public.lead_visible(id))
  with check (public.is_org_member(org_id) and (assigned_to is null or public.can_see_user(org_id, assigned_to) or public.lead_visible(id)));

-- ───────────────────────── Row level security ─────────────────────────
alter table public.batches enable row level security;
alter table public.batch_leads enable row level security;
alter table public.profession_categories enable row level security;
alter table public.customers enable row level security;

create or replace function public.is_org_manager(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_org_admin(p_org) or public.org_role(p_org) = 'manager'
$$;

create policy batches_select on public.batches for select using (public.is_org_member(org_id));
create policy batches_write on public.batches for all using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));

create policy batch_leads_select on public.batch_leads for select using (public.lead_visible(lead_id));
create policy batch_leads_write on public.batch_leads for all using (public.is_org_manager(org_id)) with check (
  public.is_org_manager(org_id)
  and exists (select 1 from public.batches b where b.id = batch_id and b.org_id = batch_leads.org_id)
  and exists (select 1 from public.leads l where l.id = lead_id and l.org_id = batch_leads.org_id)
);

create policy categories_select on public.profession_categories for select using (public.is_org_member(org_id));
create policy categories_write on public.profession_categories for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- Buyers list is management-only; reps see "already enrolled" through lead_enrollments().
create policy customers_manage on public.customers for all using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));

-- ───────────────────────── Profession categories ─────────────────────────
-- First category (by position) with a keyword that appears as a whole word in the profession.
create or replace function public.categorize_profession(p_org uuid, p_profession text)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.profession_categories c
  where c.org_id = p_org and p_profession is not null and exists (
    select 1 from unnest(c.keywords) k
    where length(trim(k)) > 0
      and lower(p_profession) ~ ('(^|[^a-z0-9])' || regexp_replace(lower(trim(k)), '([^a-z0-9 ])', '\\\1', 'g') || '($|[^a-z0-9])')
  )
  order by c.position, c.name
  limit 1
$$;

create or replace function public.auto_profession_category()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.profession is distinct from (case when tg_op = 'UPDATE' then old.profession end)
     and (tg_op = 'INSERT' or new.profession_category_id is not distinct from old.profession_category_id) then
    new.profession_category_id := coalesce(public.categorize_profession(new.org_id, new.profession), new.profession_category_id);
  end if;
  return new;
end $$;
create trigger t_lead_profession before insert or update of profession on public.leads
  for each row execute function public.auto_profession_category();

create or replace function public.seed_org_defaults(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profession_categories (org_id, name, position, keywords) values
    (p_org, 'Finance & Insurance', 1, array['insurance','lic','ca','chartered accountant','accountant','accounts','loan','loans','finance','financial','banking','bank','banker','mutual fund','mutual funds','tax','gst','investment','investor','stock','stocks','share market','wealth','nbfc','credit']),
    (p_org, 'Digital Marketing Agency', 2, array['digital marketing','performance marketing','seo','gmb','google my business','social media','smm','marketing agency','agency','meta ads','facebook ads','google ads','lead generation','branding']),
    (p_org, 'Real Estate', 3, array['real estate','property','properties','builder','broker','realtor','construction','developer real estate']),
    (p_org, 'Education & Coaching', 4, array['teacher','tutor','tuition','coach','coaching','trainer','training','education','school','professor','lecturer','institute','academy','edtech']),
    (p_org, 'Healthcare & Wellness', 5, array['doctor','dr','dentist','physiotherapist','physio','nurse','clinic','hospital','pharma','pharmacist','chemist','nutritionist','dietitian','psychologist','therapist','yoga','fitness','gym','wellness']),
    (p_org, 'IT & Software', 6, array['software','developer','programmer','it','web developer','app developer','tech','data','saas','engineer','coder']),
    (p_org, 'E-commerce & D2C', 7, array['ecommerce','e-commerce','amazon','flipkart','meesho','shopify','d2c','online store','dropshipping','online selling','seller']),
    (p_org, 'Retail & Trading Business', 8, array['shop','shop owner','retail','retailer','store','wholesaler','wholesale','distributor','dealer','kirana','trader','trading business']),
    (p_org, 'Manufacturing', 9, array['manufacturer','manufacturing','factory','production','industry','industrial','plant']),
    (p_org, 'Freelancer & Creator', 10, array['freelancer','freelance','designer','graphic designer','content creator','creator','youtuber','influencer','photographer','video editor','editor','writer','copywriter']),
    (p_org, 'Consulting & Legal', 11, array['consultant','consulting','consultancy','lawyer','advocate','legal','hr consultant']),
    (p_org, 'Salaried Professional', 12, array['job','salaried','employee','working professional','corporate','manager','executive','service','private job','government job','govt job']),
    (p_org, 'Business Owner', 13, array['business','business owner','businessman','entrepreneur','startup','founder','owner','self employed','self-employed']),
    (p_org, 'Student', 14, array['student','college','fresher','graduate','studying']),
    (p_org, 'Homemaker', 15, array['homemaker','housewife','home maker','house wife'])
  on conflict (org_id, name) do nothing;

  insert into public.call_outcomes (org_id, code, label, category, purpose, position) values
    (p_org, 'r_guided',          'Guided',                     'positive',      'reminder', 101),
    (p_org, 'r_didnt_pick',      'Didn''t pick',               'not_connected', 'reminder', 102),
    (p_org, 'r_switched_off',    'Switched off',               'not_connected', 'reminder', 103),
    (p_org, 'r_wrong_number',    'Wrong number',               'invalid',       'reminder', 104),
    (p_org, 'r_incoming_na',     'Incoming calls not available','not_connected','reminder', 105),
    (p_org, 'r_someone_else',    'Someone else picked',        'connected',     'reminder', 106),
    (p_org, 'r_out_of_service',  'Out of service',             'not_connected', 'reminder', 107),
    (p_org, 'r_not_reachable',   'Not reachable',              'not_connected', 'reminder', 108),
    (p_org, 'r_disconnected',    'Disconnected after intro',   'connected',     'reminder', 109),
    (p_org, 'r_call_later',      'Asked to call later',        'connected',     'reminder', 110),
    (p_org, 'r_busy',            'Busy on another call',       'not_connected', 'reminder', 111),
    (p_org, 'r_invalid',         'Invalid number',             'invalid',       'reminder', 112),
    (p_org, 'r_not_interested',  'Not interested',             'lost',          'reminder', 113)
  on conflict (org_id, code) do nothing;
end $$;

-- Existing companies get the defaults now; new companies get them from create_organization().
do $$ declare o record; begin
  for o in select id from public.organizations loop perform public.seed_org_defaults(o.id); end loop;
end $$;

create or replace function public.after_org_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.seed_org_defaults(new.id); return new; end $$;
create trigger t_org_defaults after insert on public.organizations
  for each row execute function public.after_org_created();

-- ───────────────────────── Buyers ("already enrolled") ─────────────────────────
create or replace function public.lead_enrollments(p_lead uuid)
returns table (product text, purchased_at timestamptz, amount numeric)
language sql stable security definer set search_path = '' as $$
  select c.product, c.purchased_at, c.amount
  from public.leads l
  join public.customers c on c.org_id = l.org_id
    and (c.phone = l.phone or (l.email is not null and lower(c.email) = l.email))
  where l.id = p_lead and public.lead_visible(p_lead)
  order by c.purchased_at desc nulls last
$$;

-- p_rows: [{"name","phone","email","product","purchased_at","amount"}]
create or replace function public.import_customers(p_org uuid, p_rows jsonb, p_product text default null, p_source text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_prefix text; v_phone text; v_email text; v_product text; v_at timestamptz; ins int := 0; skip int := 0;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only admins and managers can upload buyers'; end if;
  if jsonb_array_length(p_rows) > 20000 then raise exception 'Upload at most 20,000 rows at a time'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(nullif(r->>'phone', ''), v_prefix);
    v_email := nullif(lower(trim(r->>'email')), '');
    v_product := coalesce(nullif(trim(r->>'product'), ''), p_product);
    v_at := case when coalesce(r->>'purchased_at', '') ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}'
                 then to_timestamp(substring(r->>'purchased_at' from '^\d{1,2}[/-]\d{1,2}[/-]\d{4}'), 'DD/MM/YYYY')
                 else nullif(r->>'purchased_at', '')::timestamptz end;
    if (v_phone is null and v_email is null) or v_product is null then skip := skip + 1; continue; end if;
    if exists (select 1 from public.customers where org_id = p_org and product = v_product
               and ((v_phone is not null and phone = v_phone) or (v_email is not null and lower(email) = v_email))) then
      skip := skip + 1; continue;
    end if;
    insert into public.customers (org_id, name, phone, email, product, purchased_at, amount, source, created_by)
    values (p_org, nullif(r->>'name', ''), v_phone, v_email, v_product, v_at,
            nullif(regexp_replace(coalesce(r->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, p_source, auth.uid());
    ins := ins + 1;
  end loop;
  perform public.write_audit(p_org, 'customers.imported', 'customer', null, jsonb_build_object('inserted', ins, 'skipped', skip));
  return jsonb_build_object('inserted', ins, 'skipped', skip);
end $$;

-- ───────────────────────── Lead import with batches ─────────────────────────
-- Same as before, plus: with a batch, numbers already in Closer OS JOIN the batch
-- (marked "Repeated") instead of being skipped. "watch_minutes" is an optional column.
drop function public.import_leads(uuid, jsonb, text, text, text, uuid);
create or replace function public.import_leads(
  p_org uuid, p_rows jsonb, p_source text default null, p_campaign text default null,
  p_assign_mode text default 'rules', p_assign_to uuid default null, p_batch uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
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

    select l.id into v_existing from public.leads l where l.org_id = p_org and l.phone = v_phone and l.deleted_at is null;
    if v_existing is null then
      select lp.lead_id into v_existing from public.lead_phones lp where lp.org_id = p_org and lp.phone = v_phone;
    end if;

    if v_existing is not null then
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
end $$;

-- ───────────────────────── Zoom attendance ─────────────────────────
-- p_rows: one row per attendee, minutes already summed: [{"name","email","phone","minutes"}].
-- Matches by email first, then phone (incl. alternate numbers). Matched leads not yet in the
-- batch are added to it. Leads in the batch who did not attend get 0 minutes.
create or replace function public.apply_zoom_report(p_batch uuid, p_rows jsonb)
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
      unmatched := unmatched || jsonb_build_array(r);
      continue;
    end if;
    if not exists (select 1 from public.batch_leads where batch_id = p_batch and lead_id = v_lead) then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (p_batch, v_lead, v_org, true);
      added := added + 1;
    end if;
    update public.batch_leads set watch_minutes = case when v_lead = any(matched) then coalesce(watch_minutes, 0) + v_min else v_min end,
      attended = v_min > 0 or attended
    where batch_id = p_batch and lead_id = v_lead;
    matched := matched || v_lead;
  end loop;

  update public.batch_leads set watch_minutes = 0, attended = false
  where batch_id = p_batch and not (lead_id = any(matched));
  update public.batches set zoom_uploaded_at = now() where id = p_batch;
  perform public.write_audit(v_org, 'batch.zoom_uploaded', 'batch', p_batch::text,
    jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added', added, 'unmatched', jsonb_array_length(unmatched)));
  return jsonb_build_object('by_email', by_email, 'by_phone', by_phone, 'added_to_batch', added, 'unmatched', unmatched);
end $$;

-- Gives reminder calls of a batch to people (round-robin), only for leads without a reminder caller
-- unless p_overwrite.
create or replace function public.assign_reminders(p_batch uuid, p_user_ids uuid[], p_overwrite boolean default false)
returns int language plpgsql security definer set search_path = '' as $$
declare v_org uuid; n int; i int := 0; x record;
begin
  select org_id into v_org from public.batches where id = p_batch;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Not allowed'; end if;
  n := coalesce(cardinality(p_user_ids), 0);
  if n = 0 then raise exception 'Choose at least one person'; end if;
  for x in select lead_id from public.batch_leads where batch_id = p_batch and (p_overwrite or reminder_by is null) order by added_at loop
    update public.batch_leads set reminder_by = p_user_ids[(i % n) + 1] where batch_id = p_batch and lead_id = x.lead_id;
    i := i + 1;
  end loop;
  perform public.write_audit(v_org, 'batch.reminders_assigned', 'batch', p_batch::text, jsonb_build_object('count', i, 'users', p_user_ids));
  return i;
end $$;

-- ───────────────────────── log_call: purpose + batch ─────────────────────────
create or replace function public.log_call(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
                            recording_status, purpose, batch_id)
  values (
    v_id, v_org, v_lead, auth.uid(), p->>'device_id', (p->>'direction')::public.call_direction,
    public.normalize_phone(p->>'phone', v_prefix), (p->>'started_at')::timestamptz, nullif(p->>'ended_at', '')::timestamptz,
    coalesce((p->>'duration_sec')::int, 0), nullif(p->>'sim_slot', '')::int, p->>'sim_label', v_outcome,
    coalesce(p->'outcome_data', '{}'::jsonb), p->>'notes', coalesce((p->>'from_dialer_queue')::boolean, false),
    coalesce(nullif(p->>'recording_status', ''), 'not_expected')::public.recording_status, v_purpose, v_batch
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
    batch_id = coalesce(excluded.batch_id, public.calls.batch_id)
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

    if v_outcome is not null then
      -- Each outcome sets the lead's one next-call time for this kind of call (sales or reminder).
      update public.follow_ups
      set status = case when due_at <= now() then 'done'::public.follow_up_status else 'cancelled'::public.follow_up_status end,
          completed_at = now()
      where lead_id = v_lead and status = 'pending' and purpose = v_purpose;

      if v_follow is not null then
        insert into public.follow_ups (org_id, lead_id, assigned_to, due_at, reason, notes, call_id, created_by, priority, purpose)
        values (v_org, v_lead,
                case when v_purpose = 'reminder' then auth.uid() else coalesce((select assigned_to from public.leads where id = v_lead), auth.uid()) end,
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
end $$;

-- ───────────────────────── Batch report ─────────────────────────
-- One row per lead in the batch with everything the sales and reminder reports count.
create or replace function public.batch_lead_facts(p_batch uuid, p_purpose text)
returns table (
  lead_id uuid, rep uuid, name text, phone text, watch_minutes int, attended boolean, is_hot boolean, is_repeat boolean,
  attempts int, max_dur int, last_outcome_id uuid, guided boolean, profession_marked boolean, profession_category_id uuid,
  won boolean, revenue numeric, prev_enrolled boolean, new_enrolled boolean
) language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_hot int; v_at timestamptz; v_users uuid[];
begin
  select org_id, hot_minutes, webinar_at into v_org, v_hot, v_at from public.batches where id = p_batch;
  if v_org is null or not public.is_org_member(v_org) then raise exception 'Not allowed'; end if;
  if p_purpose not in ('sales', 'reminder') then raise exception 'Unknown report type'; end if;
  v_users := public.visible_user_ids(v_org);

  return query
  with bl as (
    select b.lead_id, b.watch_minutes, b.attended, b.is_repeat, l.name, l.phone, l.email,
      l.profession, l.profession_category_id,
      case when p_purpose = 'reminder' then coalesce(b.reminder_by, l.assigned_to) else l.assigned_to end as rep
    from public.batch_leads b
    join public.leads l on l.id = b.lead_id and l.deleted_at is null
    where b.batch_id = p_batch
  ),
  vis as (
    select * from bl where (bl.rep is null and public.is_org_manager(v_org)) or bl.rep = any(v_users)
  ),
  c as (
    select k.lead_id, count(*)::int as attempts, max(k.duration_sec)::int as max_dur,
      bool_or(o.code = 'r_guided') as guided,
      bool_or(o.category = 'won') as won,
      sum(case when o.category = 'won' then coalesce(nullif(regexp_replace(coalesce(k.outcome_data->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) else 0 end) as revenue,
      (array_agg(k.outcome_id order by k.started_at desc) filter (where k.outcome_id is not null))[1] as last_outcome_id
    from public.calls k
    left join public.call_outcomes o on o.id = k.outcome_id
    where k.batch_id = p_batch and k.purpose = p_purpose and k.lead_id in (select vis.lead_id from vis)
    group by k.lead_id
  ),
  -- Guided / won can come from either kind of call: count them for both reports.
  any_call as (
    select k.lead_id, bool_or(o.code = 'r_guided') as guided, bool_or(o.category = 'won') as won
    from public.calls k join public.call_outcomes o on o.id = k.outcome_id
    where k.batch_id = p_batch and k.lead_id in (select vis.lead_id from vis)
    group by k.lead_id
  ),
  buy as (
    select v.lead_id,
      bool_or(cu.purchased_at < v_at) as prev,
      bool_or(cu.purchased_at >= v_at) as new
    from vis v join public.customers cu on cu.org_id = v_org
      and (cu.phone = v.phone or (v.email is not null and lower(cu.email) = v.email))
    group by v.lead_id
  )
  select v.lead_id, v.rep, v.name, v.phone, v.watch_minutes, v.attended,
    coalesce(v.watch_minutes, 0) >= v_hot and v.watch_minutes is not null and v.watch_minutes > 0,
    v.is_repeat,
    coalesce(c.attempts, 0), coalesce(c.max_dur, 0), c.last_outcome_id,
    coalesce(a.guided, false),
    v.profession is not null and v.profession <> '' or v.profession_category_id is not null,
    v.profession_category_id,
    coalesce(a.won, false), coalesce(c.revenue, 0),
    coalesce(buy.prev, false),
    coalesce(buy.new, false) or coalesce(a.won, false)
  from vis v
  left join c on c.lead_id = v.lead_id
  left join any_call a on a.lead_id = v.lead_id
  left join buy on buy.lead_id = v.lead_id;
end $$;

create or replace function public.batch_report(p_batch uuid, p_purpose text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with f as (select * from public.batch_lead_facts(p_batch, p_purpose)),
  per_rep as (
    select grouping(rep) as g, rep,
      count(*) as assigned,
      count(*) filter (where attended) as attended,
      count(*) filter (where is_hot) as hot,
      count(*) filter (where attempts > 0) as called,
      count(*) filter (where max_dur > 30) as picked,
      count(*) filter (where attempts > 0 and max_dur between 1 and 30) as picked_short,
      count(*) filter (where attempts > 0 and max_dur = 0) as not_picked,
      count(*) filter (where attempts > 0 and max_dur = 0 and is_hot) as not_picked_hot,
      count(*) filter (where max_dur > 300) as over5,
      count(*) filter (where max_dur > 300 and is_hot) as over5_hot,
      count(*) filter (where attempts = 0) as left_to_dial,
      count(*) filter (where attempts = 0 and is_hot) as left_to_dial_hot,
      count(*) filter (where guided) as guided,
      count(*) filter (where profession_marked) as professions,
      count(*) filter (where is_repeat) as repeated,
      count(*) filter (where prev_enrolled) as prev_enrolled,
      count(*) filter (where new_enrolled) as new_enrolled,
      count(*) filter (where won) as won,
      coalesce(sum(revenue), 0) as revenue
    from f group by grouping sets ((rep), ())
  ),
  outcomes as (
    select grouping(rep) as g, rep, last_outcome_id as outcome_id, count(*) as leads
    from f where attempts > 0 group by grouping sets ((rep, last_outcome_id), (last_outcome_id))
  ),
  cats as (
    select profession_category_id as category_id, count(*) as leads from f group by profession_category_id
  )
  select jsonb_build_object(
    'reps', coalesce((select jsonb_agg(to_jsonb(per_rep)) from per_rep), '[]'::jsonb),
    'outcomes', coalesce((select jsonb_agg(to_jsonb(outcomes)) from outcomes), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(cats)) from cats), '[]'::jsonb)
  )
$$;

-- Leads behind any number in the batch report (for click-through).
create or replace function public.batch_report_leads(p_batch uuid, p_purpose text, p_metric text, p_rep uuid default null, p_outcome uuid default null)
returns table (lead_id uuid, rep uuid, name text, phone text, watch_minutes int, attempts int, max_dur int, last_outcome_id uuid)
language sql stable security definer set search_path = '' as $$
  select f.lead_id, f.rep, f.name, f.phone, f.watch_minutes, f.attempts, f.max_dur, f.last_outcome_id
  from public.batch_lead_facts(p_batch, p_purpose) f
  where (p_rep is null or f.rep = p_rep)
    and case p_metric
      when 'assigned' then true
      when 'attended' then f.attended
      when 'hot' then f.is_hot
      when 'called' then f.attempts > 0
      when 'picked' then f.max_dur > 30
      when 'picked_short' then f.attempts > 0 and f.max_dur between 1 and 30
      when 'not_picked' then f.attempts > 0 and f.max_dur = 0
      when 'not_picked_hot' then f.attempts > 0 and f.max_dur = 0 and f.is_hot
      when 'over5' then f.max_dur > 300
      when 'over5_hot' then f.max_dur > 300 and f.is_hot
      when 'left_to_dial' then f.attempts = 0
      when 'left_to_dial_hot' then f.attempts = 0 and f.is_hot
      when 'guided' then f.guided
      when 'not_guided' then not f.guided
      when 'professions' then f.profession_marked
      when 'repeated' then f.is_repeat
      when 'prev_enrolled' then f.prev_enrolled
      when 'new_enrolled' then f.new_enrolled
      when 'won' then f.won
      when 'outcome' then f.attempts > 0 and f.last_outcome_id is not distinct from p_outcome
      else false end
  order by f.watch_minutes desc nulls last, f.name
  limit 5000
$$;

revoke execute on function public.batch_lead_facts(uuid, text) from anon, public;
revoke execute on function public.batch_report(uuid, text) from anon, public;
revoke execute on function public.batch_report_leads(uuid, text, text, uuid, uuid) from anon, public;
revoke execute on function public.apply_zoom_report(uuid, jsonb) from anon, public;
revoke execute on function public.assign_reminders(uuid, uuid[], boolean) from anon, public;
revoke execute on function public.import_customers(uuid, jsonb, text, text) from anon, public;
revoke execute on function public.import_leads(uuid, jsonb, text, text, text, uuid, uuid) from anon, public;
revoke execute on function public.lead_enrollments(uuid) from anon, public;
revoke execute on function public.categorize_profession(uuid, text) from anon, public;
revoke execute on function public.seed_org_defaults(uuid) from anon, public, authenticated;
revoke execute on function public.is_org_manager(uuid) from anon, public;
grant execute on function public.batch_report(uuid, text) to authenticated;
grant execute on function public.batch_report_leads(uuid, text, text, uuid, uuid) to authenticated;
grant execute on function public.batch_lead_facts(uuid, text) to authenticated;
grant execute on function public.apply_zoom_report(uuid, jsonb) to authenticated;
grant execute on function public.assign_reminders(uuid, uuid[], boolean) to authenticated;
grant execute on function public.import_customers(uuid, jsonb, text, text) to authenticated;
grant execute on function public.import_leads(uuid, jsonb, text, text, text, uuid, uuid) to authenticated;
grant execute on function public.lead_enrollments(uuid) to authenticated;
grant execute on function public.categorize_profession(uuid, text) to authenticated;
grant execute on function public.is_org_manager(uuid) to authenticated;
