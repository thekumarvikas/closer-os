-- Billing & subscriptions: plans (set by Closer OS Super Admin), one subscription per company,
-- trial → paid via Razorpay (orders: UPI, cards, netbanking), grace period, suspension without
-- deleting data. Prices are per user (seat) per month or per year.

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  price_month int not null check (price_month >= 0),      -- per user per month, in rupees
  price_year int not null check (price_year >= 0),        -- per user per year, in rupees
  currency text not null default 'INR',
  features jsonb not null default '{}'::jsonb,            -- what the plan includes (for display + future limits)
  min_seats int not null default 1,
  is_public boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.plans enable row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (auth.uid() is not null);

create table if not exists public.platform_settings (
  id boolean primary key default true check (id),
  trial_days int not null default 14,
  grace_days int not null default 7,
  razorpay_key_id text,                                   -- public key id (the secret lives in Vault)
  seller_name text default 'Closer OS',
  seller_address text,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict do nothing;
alter table public.platform_settings enable row level security;
drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read on public.platform_settings for select using (auth.uid() is not null);

create table if not exists public.subscriptions (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  plan_id uuid references public.plans(id),
  status text not null default 'trialing' check (status in ('trialing', 'active', 'cancelled', 'complimentary')),
  seats int not null default 1 check (seats >= 1),
  cycle text not null default 'month' check (cycle in ('month', 'year')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  note text,                                              -- Super Admin's note (e.g. "extended trial")
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_read on public.subscriptions;
create policy subscriptions_read on public.subscriptions for select using (public.is_org_member(org_id) or public.is_super_admin());

create sequence if not exists public.receipt_no_seq start 1001;
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid references public.plans(id),
  seats int not null,
  cycle text not null,
  amount int not null,                                    -- rupees
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created', 'paid', 'failed')),
  razorpay_order_id text unique,
  razorpay_payment_id text,
  period_start timestamptz,
  period_end timestamptz,
  receipt_no int,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  raw jsonb
);
create index if not exists payments_org_idx on public.payments (org_id, created_at desc);
alter table public.payments enable row level security;
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select using (public.is_org_admin(org_id) or public.is_super_admin());

-- Example plans (Super Admin edits names, prices and contents).
insert into public.plans (code, name, description, price_month, price_year, features, position) values
  ('starter', 'Starter', 'Call tracking, reports, leads and follow-ups', 399, 3990,
   '{"call_tracking":true,"reports":true,"follow_ups":true,"lead_sources":true,"recordings":false,"webinars":false,"playbook":true,"reviews":false}', 1),
  ('growth', 'Growth', 'Everything in Starter + recordings, webinars, call reviews, IndiaMART', 699, 6990,
   '{"call_tracking":true,"reports":true,"follow_ups":true,"lead_sources":true,"recordings":true,"webinars":true,"playbook":true,"reviews":true}', 2),
  ('pro', 'Pro', 'Everything in Growth + priority support (AI analysis when it launches)', 999, 9990,
   '{"call_tracking":true,"reports":true,"follow_ups":true,"lead_sources":true,"recordings":true,"webinars":true,"playbook":true,"reviews":true,"ai":true}', 3)
on conflict (code) do nothing;

-- Every company gets a trial when it is created; existing companies start a trial now.
create or replace function public.start_trial() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions (org_id, plan_id, status, trial_ends_at)
  values (new.id, (select id from public.plans where code = 'growth'), 'trialing',
          now() + make_interval(days => (select trial_days from public.platform_settings)))
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists t_org_trial on public.organizations;
create trigger t_org_trial after insert on public.organizations for each row execute function public.start_trial();
insert into public.subscriptions (org_id, plan_id, status, trial_ends_at)
select o.id, (select id from public.plans where code = 'growth'), 'trialing', now() + interval '14 days'
from public.organizations o on conflict do nothing;

-- The owner's own company is free, and the owner is the Closer OS Super Admin.
update public.profiles set is_super_admin = true where id in (
  select m.user_id from public.org_members m join public.organizations o on o.id = m.org_id where o.name = 'Vikas Kumar Consulting' and m.role = 'owner');
update public.subscriptions s set status = 'complimentary', note = 'Closer OS owner'
from public.organizations o where o.id = s.org_id and o.name = 'Vikas Kumar Consulting';

-- What a company may do right now. state: trial | active | grace (expired but still working) | expired.
create or replace function public.org_access(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions; p public.plans; g int; v_end timestamptz; v_state text; v_used int;
begin
  if not (public.is_org_member(p_org) or public.is_super_admin()) then raise exception 'Not allowed'; end if;
  select * into s from public.subscriptions where org_id = p_org;
  select * into p from public.plans where id = s.plan_id;
  select grace_days into g from public.platform_settings;
  select count(*) into v_used from public.org_members where org_id = p_org and status = 'active';
  v_end := case s.status when 'trialing' then s.trial_ends_at when 'active' then s.current_period_end else null end;
  v_state := case
    when s.org_id is null or s.status = 'complimentary' then 'active'
    when s.status = 'cancelled' then 'expired'
    when v_end > now() then case when s.status = 'trialing' then 'trial' else 'active' end
    when v_end + make_interval(days => g) > now() then 'grace'
    else 'expired' end;
  return jsonb_build_object('state', v_state, 'status', coalesce(s.status, 'complimentary'), 'plan', p.name, 'plan_id', p.id,
    'features', coalesce(p.features, '{}'::jsonb), 'seats', coalesce(s.seats, 9999), 'seats_used', v_used, 'cycle', s.cycle,
    'ends_at', v_end, 'grace_ends_at', v_end + make_interval(days => g),
    'days_left', case when v_end is null then null else greatest(0, ceil(extract(epoch from (v_end - now())) / 86400))::int end);
end $$;

-- Price for a renewal / upgrade (used by the payment function; also shown on the Billing page).
create or replace function public.price_quote(p_org uuid, p_plan uuid, p_seats int, p_cycle text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.plans; s public.subscriptions; v_start timestamptz; v_end timestamptz; v_amount int;
begin
  if not (public.is_org_admin(p_org) or public.is_super_admin()) then raise exception 'Only the company owner or an admin can pay'; end if;
  select * into p from public.plans where id = p_plan;
  if p.id is null then raise exception 'Unknown plan'; end if;
  if p_cycle not in ('month', 'year') then raise exception 'Choose monthly or yearly'; end if;
  if p_seats < greatest(p.min_seats, 1) or p_seats > 1000 then raise exception 'Choose between % and 1000 users', greatest(p.min_seats, 1); end if;
  if p_seats < (select count(*) from public.org_members where org_id = p_org and status = 'active') then
    raise exception 'You have more active people than that — deactivate some on the Team page or choose more users';
  end if;
  select * into s from public.subscriptions where org_id = p_org;
  -- A renewal starts when the current paid period ends (or now if it has already ended / trial).
  v_start := case when s.status = 'active' and s.current_period_end > now() then s.current_period_end else now() end;
  v_end := v_start + case when p_cycle = 'year' then interval '1 year' else interval '1 month' end;
  v_amount := p_seats * case when p_cycle = 'year' then p.price_year else p.price_month end;
  return jsonb_build_object('plan', p.name, 'seats', p_seats, 'cycle', p_cycle, 'amount', v_amount, 'currency', p.currency,
    'period_start', v_start, 'period_end', v_end);
end $$;

-- Called by the payment function (service role) once Razorpay confirms the payment. Idempotent.
create or replace function public.apply_payment(p_order text, p_payment text, p_raw jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pay public.payments;
begin
  select * into pay from public.payments where razorpay_order_id = p_order for update;
  if pay.id is null then return jsonb_build_object('ok', false, 'error', 'Unknown order'); end if;
  if pay.status = 'paid' then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.payments set status = 'paid', razorpay_payment_id = p_payment, paid_at = now(), raw = p_raw,
    receipt_no = nextval('public.receipt_no_seq') where id = pay.id;
  insert into public.subscriptions (org_id, plan_id, status, seats, cycle, current_period_end, updated_at)
  values (pay.org_id, pay.plan_id, 'active', pay.seats, pay.cycle, pay.period_end, now())
  on conflict (org_id) do update set plan_id = excluded.plan_id, status = 'active', seats = excluded.seats, cycle = excluded.cycle,
    current_period_end = greatest(coalesce(public.subscriptions.current_period_end, now()), excluded.current_period_end), updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- ───────────── Super Admin ─────────────
create or replace function public.sa_companies()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('id', o.id, 'name', o.name, 'created_at', o.created_at,
      'owner', (select p.email from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = o.id and m.role = 'owner' limit 1),
      'users', (select count(*) from public.org_members m where m.org_id = o.id and m.status = 'active'),
      'calls_7d', (select count(*) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days'),
      'last_call', (select max(started_at) from public.calls c where c.org_id = o.id),
      'status', s.status, 'plan', pl.name, 'plan_id', s.plan_id, 'seats', s.seats, 'cycle', s.cycle,
      'trial_ends_at', s.trial_ends_at, 'current_period_end', s.current_period_end, 'note', s.note,
      'paid_total', (select coalesce(sum(amount), 0) from public.payments py where py.org_id = o.id and py.status = 'paid')) as x
    from public.organizations o left join public.subscriptions s on s.org_id = o.id left join public.plans pl on pl.id = s.plan_id) t;
  return res;
end $$;

create or replace function public.sa_update_subscription(p_org uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  insert into public.subscriptions (org_id) values (p_org) on conflict do nothing;
  update public.subscriptions set
    status = coalesce(p->>'status', status),
    plan_id = coalesce(nullif(p->>'plan_id', '')::uuid, plan_id),
    seats = coalesce((p->>'seats')::int, seats),
    cycle = coalesce(p->>'cycle', cycle),
    trial_ends_at = case when p ? 'trial_ends_at' then nullif(p->>'trial_ends_at', '')::timestamptz else trial_ends_at end,
    current_period_end = case when p ? 'current_period_end' then nullif(p->>'current_period_end', '')::timestamptz else current_period_end end,
    note = case when p ? 'note' then nullif(p->>'note', '') else note end,
    updated_at = now()
  where org_id = p_org;
  perform public.write_audit(p_org, 'subscription_changed', 'subscription', p_org::text, p);
end $$;

create or replace function public.sa_save_plan(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  if v_id is null then
    insert into public.plans (code, name, description, price_month, price_year, features, min_seats, is_public, position)
    values (lower(regexp_replace(p->>'name', '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(md5(random()::text), 1, 4), p->>'name', p->>'description',
      (p->>'price_month')::int, (p->>'price_year')::int, coalesce(p->'features', '{}'), coalesce((p->>'min_seats')::int, 1),
      coalesce((p->>'is_public')::boolean, true), coalesce((p->>'position')::int, 9))
    returning id into v_id;
  else
    update public.plans set name = p->>'name', description = p->>'description', price_month = (p->>'price_month')::int,
      price_year = (p->>'price_year')::int, features = coalesce(p->'features', features), min_seats = coalesce((p->>'min_seats')::int, min_seats),
      is_public = coalesce((p->>'is_public')::boolean, is_public), position = coalesce((p->>'position')::int, position)
    where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.sa_save_settings(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  update public.platform_settings set trial_days = coalesce((p->>'trial_days')::int, trial_days), grace_days = coalesce((p->>'grace_days')::int, grace_days),
    razorpay_key_id = case when p ? 'razorpay_key_id' then nullif(trim(p->>'razorpay_key_id'), '') else razorpay_key_id end,
    seller_name = coalesce(nullif(p->>'seller_name', ''), seller_name),
    seller_address = case when p ? 'seller_address' then p->>'seller_address' else seller_address end, updated_at = now();
  -- Secrets go to Vault and are never sent back.
  if coalesce(p->>'razorpay_key_secret', '') <> '' then
    perform vault.create_secret(p->>'razorpay_key_secret', 'razorpay_key_secret_' || substr(md5(random()::text), 1, 6));
    delete from vault.secrets where name like 'razorpay_key_secret%' and name <> (select name from vault.secrets where name like 'razorpay_key_secret%' order by created_at desc limit 1);
  end if;
  if coalesce(p->>'razorpay_webhook_secret', '') <> '' then
    perform vault.create_secret(p->>'razorpay_webhook_secret', 'razorpay_webhook_secret_' || substr(md5(random()::text), 1, 6));
    delete from vault.secrets where name like 'razorpay_webhook_secret%' and name <> (select name from vault.secrets where name like 'razorpay_webhook_secret%' order by created_at desc limit 1);
  end if;
end $$;

-- Which secrets are set (yes/no only).
create or replace function public.sa_secrets_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.is_super_admin() then jsonb_build_object(
    'key_secret', exists (select 1 from vault.secrets where name like 'razorpay_key_secret%'),
    'webhook_secret', exists (select 1 from vault.secrets where name like 'razorpay_webhook_secret%')) end
$$;

-- For the payment function only (service role).
create or replace function public.billing_secret(p_kind text)
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name like 'razorpay_' || p_kind || '_secret%' order by created_at desc limit 1
$$;
revoke execute on function public.billing_secret(text) from anon, public, authenticated;
revoke execute on function public.apply_payment(text, text, jsonb) from anon, public, authenticated;

create or replace function public.sa_revenue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('month', m, 'amount', a, 'payments', n) order by m desc), '[]'::jsonb) into res
  from (select to_char(paid_at at time zone 'Asia/Kolkata', 'YYYY-MM') m, sum(amount) a, count(*) n from public.payments where status = 'paid' group by 1) t;
  return res;
end $$;

do $$ declare f text; begin
  foreach f in array array['org_access(uuid)', 'price_quote(uuid, uuid, int, text)', 'sa_companies()', 'sa_update_subscription(uuid, jsonb)',
    'sa_save_plan(jsonb)', 'sa_save_settings(jsonb)', 'sa_secrets_status()', 'sa_revenue()'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
