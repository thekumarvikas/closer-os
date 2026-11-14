-- Verified sales (Nov 2026). A rep claims a sale (automatically when they save a "won" outcome, or with "Claim a sale");
-- a manager verifies it after seeing the facts (calls, talk, WhatsApp, recordings, webinars, red flags) and gives the
-- credit. Only VERIFIED sales count in reports. Payments are entered by managers (full / part / refund; UPI, bank,
-- cash…). An order stays "Balance due" until fully paid. Managers can lock a month. Price list in Settings.

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  price numeric(14, 2),
  is_active boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists products_org on public.products (org_id, position);
alter table public.products enable row level security;
drop policy if exists products_select on public.products;
create policy products_select on public.products for select using (public.is_org_member(org_id));
drop policy if exists products_write on public.products;
create policy products_write on public.products for all using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  product text,
  amount numeric(14, 2) not null default 0 check (amount >= 0),     -- order value
  sold_at timestamptz not null default now(),
  status text not null default 'claimed' check (status in ('claimed', 'verified', 'rejected')),
  source text not null default 'claim',                             -- claim | outcome | manager | import | backfill
  claimed_by uuid references auth.users(id) on delete set null,
  credited_to uuid references auth.users(id) on delete set null,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  review_note text,
  note text,
  call_id uuid references public.calls(id) on delete set null,
  buyer jsonb,                                                      -- imported buyer row (name / phone / email as given)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sales_org_status on public.sales (org_id, status, sold_at desc);
create index if not exists sales_lead on public.sales (lead_id);
create index if not exists sales_credited on public.sales (org_id, credited_to, sold_at) where status = 'verified';
create unique index if not exists sales_one_per_call on public.sales (call_id) where call_id is not null;
alter table public.sales enable row level security;
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales for select using (
  public.is_org_manager(org_id) or claimed_by = auth.uid() or credited_to = auth.uid());

create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  kind text not null default 'payment' check (kind in ('payment', 'refund')),
  amount numeric(14, 2) not null check (amount > 0),
  method text not null default 'upi',                                -- upi | bank | cash | card | razorpay | cheque | other
  paid_at timestamptz not null default now(),
  reference text, note text,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sale_payments_sale on public.sale_payments (sale_id);
create index if not exists sale_payments_org on public.sale_payments (org_id, paid_at);
alter table public.sale_payments enable row level security;
drop policy if exists sale_payments_select on public.sale_payments;
create policy sale_payments_select on public.sale_payments for select using (
  exists (select 1 from public.sales s where s.id = sale_id and (public.is_org_manager(s.org_id) or s.claimed_by = auth.uid() or s.credited_to = auth.uid())));

create table if not exists public.sale_month_locks (
  org_id uuid not null references public.organizations(id) on delete cascade,
  month date not null,                                               -- first day of the month
  locked_by uuid references auth.users(id) on delete set null,
  locked_at timestamptz not null default now(),
  primary key (org_id, month)
);
alter table public.sale_month_locks enable row level security;
drop policy if exists sale_locks_select on public.sale_month_locks;
create policy sale_locks_select on public.sale_month_locks for select using (public.is_org_member(org_id));

-- Is the month of this moment locked for the company (company time zone)?
create or replace function public.sale_month_locked(p_org uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sale_month_locks l join public.organizations o on o.id = l.org_id
    where l.org_id = p_org and l.month = date_trunc('month', (p_at at time zone o.timezone))::date)
$$;

create or replace function public.t_sales_lock() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  r := coalesce(new, old);
  if tg_table_name = 'sales' then
    if public.sale_month_locked(r.org_id, r.sold_at) or (tg_op = 'UPDATE' and public.sale_month_locked(old.org_id, old.sold_at)) then
      raise exception 'This month is locked — unlock it on the Sales page to change its sales';
    end if;
  else
    if public.sale_month_locked(r.org_id, r.paid_at) or (tg_op = 'UPDATE' and public.sale_month_locked(old.org_id, old.paid_at)) then
      raise exception 'This month is locked — unlock it on the Sales page to change its payments';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists t_sales_lock on public.sales;
create trigger t_sales_lock before insert or update or delete on public.sales for each row execute function public.t_sales_lock();
drop trigger if exists t_sale_payments_lock on public.sale_payments;
create trigger t_sale_payments_lock before insert or update or delete on public.sale_payments for each row execute function public.t_sales_lock();

-- Money on a sale: paid so far, refunded, balance, status.
create or replace function public.sale_money(p_sale uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('paid', coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0),
    'refunded', coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0),
    'balance', greatest(s.amount - coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) + coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0), 0),
    'net', greatest(s.amount - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0), 0),
    'pay_status', case
      when coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) > 0 and coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) >= coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) then 'refunded'
      when coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) >= s.amount and s.amount > 0 then 'full'
      when coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) > 0 then 'part'
      else 'unpaid' end)
  from public.sales s left join public.sale_payments p on p.sale_id = s.id
  where s.id = p_sale group by s.id, s.amount
$$;

-- Revenue of one sale for reports = order value − refunds.
create or replace function public.sale_net(p_sale uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select greatest(s.amount - coalesce((select sum(amount) from public.sale_payments where sale_id = s.id and kind = 'refund'), 0), 0)
  from public.sales s where s.id = p_sale
$$;

-- A verified sale marks the lead as won.
create or replace function public.t_sale_won() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'verified' and new.lead_id is not null then
    update public.leads set won_at = least(coalesce(won_at, new.sold_at), new.sold_at), updated_at = now() where id = new.lead_id;
  end if;
  return new;
end $$;
drop trigger if exists t_sale_won on public.sales;
create trigger t_sale_won after insert or update of status, sold_at on public.sales for each row execute function public.t_sale_won();

-- A rep saved a "sale / won" outcome → a sale claim waits for a manager (one per call).
create or replace function public.t_call_sale_claim() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cat text; v_amount numeric; v_prod text; v_pid uuid;
begin
  if new.outcome_id is null or new.lead_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.outcome_id is not distinct from old.outcome_id then return new; end if;
  select category into v_cat from public.call_outcomes where id = new.outcome_id;
  if v_cat is distinct from 'won' then return new; end if;
  if exists (select 1 from public.sales where call_id = new.id) then return new; end if;
  v_amount := coalesce(nullif(regexp_replace(coalesce(new.outcome_data->>'amount', new.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0);
  v_prod := nullif(trim(new.outcome_data->>'product'), '');
  v_pid := nullif(new.outcome_data->>'product_id', '')::uuid;
  if v_pid is not null and not exists (select 1 from public.products where id = v_pid and org_id = new.org_id) then v_pid := null; end if;
  if v_prod is null and v_pid is not null then select name into v_prod from public.products where id = v_pid; end if;
  insert into public.sales (org_id, lead_id, product_id, product, amount, sold_at, status, source, claimed_by, credited_to, call_id)
  values (new.org_id, new.lead_id, v_pid, v_prod, v_amount, coalesce(new.ended_at, new.started_at, now()), 'claimed', 'outcome', new.user_id, new.user_id, new.id);
  return new;
exception when others then
  return new;   -- never block saving a call (e.g. locked month): the manager can add the sale by hand
end $$;
drop trigger if exists t_call_sale_claim on public.calls;
create trigger t_call_sale_claim after insert or update of outcome_id on public.calls for each row execute function public.t_call_sale_claim();

-- Earlier "won" calls become verified sales so history keeps its revenue.
insert into public.sales (org_id, lead_id, product, amount, sold_at, status, source, claimed_by, credited_to, verified_at, call_id)
select c.org_id, c.lead_id, nullif(trim(c.outcome_data->>'product'), ''),
  coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0),
  c.started_at, 'verified', 'backfill', c.user_id, c.user_id, now(), c.id
from public.calls c join public.call_outcomes o on o.id = c.outcome_id
where o.category = 'won' and c.lead_id is not null and not exists (select 1 from public.sales s where s.call_id = c.id);

-- ───── RPCs ─────
-- A rep (or manager) claims a sale for a lead. Managers' own entries are verified at once.
create or replace function public.claim_sale(p_lead uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid; v_pid uuid := nullif(p->>'product_id', '')::uuid; v_prod text := nullif(trim(p->>'product'), '');
  v_amount numeric := nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric; mgr boolean;
begin
  select org_id into v_org from public.leads where id = p_lead and deleted_at is null;
  if v_org is null or not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  mgr := public.is_org_manager(v_org);
  if v_pid is not null then
    select name, coalesce(v_amount, price) into v_prod, v_amount from public.products where id = v_pid and org_id = v_org;
  end if;
  if coalesce(v_amount, 0) <= 0 then raise exception 'Enter the sale amount'; end if;
  insert into public.sales (org_id, lead_id, product_id, product, amount, sold_at, status, source, claimed_by, credited_to, note,
    verified_by, verified_at)
  values (v_org, p_lead, v_pid, v_prod, v_amount, coalesce(nullif(p->>'sold_at', '')::timestamptz, now()),
    case when mgr and coalesce((p->>'verify')::boolean, true) then 'verified' else 'claimed' end, case when mgr then 'manager' else 'claim' end,
    auth.uid(), coalesce(case when mgr then nullif(p->>'credited_to', '')::uuid end, auth.uid()), nullif(trim(p->>'note'), ''),
    case when mgr then auth.uid() end, case when mgr then now() end)
  returning id into v_id;
  -- First payment entered with the claim (managers only).
  if mgr and nullif(regexp_replace(coalesce(p->>'paid', ''), '[^0-9.]', '', 'g'), '')::numeric > 0 then
    insert into public.sale_payments (org_id, sale_id, amount, method, paid_at, reference, added_by)
    values (v_org, v_id, nullif(regexp_replace(p->>'paid', '[^0-9.]', '', 'g'), '')::numeric, coalesce(nullif(p->>'method', ''), 'upi'),
      coalesce(nullif(p->>'sold_at', '')::timestamptz, now()), nullif(trim(p->>'reference'), ''), auth.uid());
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (v_org, p_lead, auth.uid(), 'sale_claimed', jsonb_build_object('sale_id', v_id, 'amount', v_amount, 'product', v_prod));
  return v_id;
end $$;

-- Manager decision: verify (and give the credit) or reject (with a reason).
create or replace function public.review_sale(p_sale uuid, p_approve boolean, p jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can verify sales'; end if;
  update public.sales set status = case when p_approve then 'verified' else 'rejected' end,
    credited_to = coalesce(nullif(p->>'credited_to', '')::uuid, credited_to),
    amount = coalesce(nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric, amount),
    product = coalesce(nullif(trim(p->>'product'), ''), product),
    product_id = coalesce(nullif(p->>'product_id', '')::uuid, product_id),
    review_note = nullif(trim(p->>'note'), ''), verified_by = auth.uid(), verified_at = now(), updated_at = now()
  where id = p_sale;
  if s.lead_id is not null then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (s.org_id, s.lead_id, auth.uid(), case when p_approve then 'sale_verified' else 'sale_rejected' end,
      jsonb_strip_nulls(jsonb_build_object('sale_id', s.id, 'note', nullif(trim(p->>'note'), ''))));
  end if;
  perform public.write_audit(s.org_id, case when p_approve then 'sale.verified' else 'sale.rejected' end, 'sale', s.id::text, p);
end $$;

-- Payment or refund on a sale (managers).
create or replace function public.add_sale_payment(p_sale uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.sales; v_id uuid; v_amount numeric := nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can add payments'; end if;
  if coalesce(v_amount, 0) <= 0 then raise exception 'Enter the amount'; end if;
  insert into public.sale_payments (org_id, sale_id, kind, amount, method, paid_at, reference, note, added_by)
  values (s.org_id, s.id, coalesce(nullif(p->>'kind', ''), 'payment'), v_amount, coalesce(nullif(p->>'method', ''), 'upi'),
    coalesce(nullif(p->>'paid_at', '')::timestamptz, now()), nullif(trim(p->>'reference'), ''), nullif(trim(p->>'note'), ''), auth.uid())
  returning id into v_id;
  perform public.write_audit(s.org_id, 'sale.payment', 'sale', s.id::text, p);
  return v_id;
end $$;

create or replace function public.delete_sale_payment(p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.sale_payments where id = p_id;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Only managers can remove payments'; end if;
  delete from public.sale_payments where id = p_id;
  perform public.write_audit(v_org, 'sale.payment_removed', 'sale_payment', p_id::text, '{}'::jsonb);
end $$;

-- Lock / unlock a month (owners and admins). A locked month's sales and payments can't change.
create or replace function public.lock_sales_month(p_org uuid, p_month date, p_lock boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_org_admin(p_org) then raise exception 'Only owners and admins can lock a month'; end if;
  if p_lock then insert into public.sale_month_locks (org_id, month, locked_by) values (p_org, date_trunc('month', p_month)::date, auth.uid()) on conflict do nothing;
  else delete from public.sale_month_locks where org_id = p_org and month = date_trunc('month', p_month)::date; end if;
  perform public.write_audit(p_org, case when p_lock then 'sales.month_locked' else 'sales.month_unlocked' end, 'org', p_org::text, jsonb_build_object('month', p_month));
end $$;

-- The facts a manager needs to verify a sale, on one screen, with red flags.
create or replace function public.sale_facts(p_sale uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.sales; l public.leads; res jsonb; flags text[] := '{}'; v_talk int; v_calls int; v_price numeric; v_other int; v_assigned boolean;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not (public.is_org_manager(s.org_id) or s.claimed_by = auth.uid()) then raise exception 'Not allowed'; end if;
  select * into l from public.leads where id = s.lead_id;
  select count(*), coalesce(sum(duration_sec) filter (where duration_sec > 0), 0) into v_calls, v_talk
    from public.calls where lead_id = s.lead_id and user_id = s.claimed_by;
  select price into v_price from public.products where id = s.product_id;
  select count(*) into v_other from public.sales where lead_id = s.lead_id and id <> s.id and status <> 'rejected'
    and abs(extract(epoch from (sold_at - s.sold_at))) < 30 * 86400;
  v_assigned := l.id is not null and (l.assigned_to = s.claimed_by or s.claimed_by = any(coalesce(l.shared_with, '{}')));
  if s.source not in ('import', 'backfill') then
    if v_calls = 0 then flags := flags || 'No calls with this lead from the person claiming it'::text;
    elsif v_talk < 60 then flags := flags || ('Only ' || v_talk || ' seconds of talk with this lead');
    end if;
    if l.id is not null and not v_assigned then flags := flags || 'Not their lead (assigned to someone else)'::text; end if;
  end if;
  if v_price is not null and s.amount <> v_price then flags := flags || ('Amount ' || s.amount || ' differs from the price list (' || v_price || ')'); end if;
  if v_other > 0 then flags := flags || ('Another sale for this lead within 30 days (' || v_other || ')'); end if;
  if l.id is not null and l.last_connected_at is not null and s.sold_at - l.last_connected_at > interval '30 days' then
    flags := flags || 'No conversation in the 30 days before the sale'::text;
  end if;

  select jsonb_build_object(
    'sale', to_jsonb(s) || public.sale_money(s.id),
    'lead', case when l.id is null then null else jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source,
      'assigned_to', l.assigned_to, 'created_at', l.created_at, 'first_dialled_at', l.first_dialled_at, 'calls', l.call_count,
      'conversations', l.conversation_count, 'talk_sec', l.total_talk_sec, 'wa', l.wa_count, 'arrivals', l.arrivals) end,
    'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'calls', n, 'talk_sec', t, 'last', last) order by t desc) from (
        select user_id, count(*) n, coalesce(sum(duration_sec) filter (where duration_sec > 0), 0) t, max(started_at) last
        from public.calls where lead_id = s.lead_id group by user_id) x), '[]'::jsonb),
    'wa', (select count(*) from public.wa_messages w where w.lead_id = s.lead_id and w.undone_at is null),
    'recordings', (select count(*) from public.calls c where c.lead_id = s.lead_id and c.recording_path is not null),
    'calls', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'at', c.started_at, 'user_id', c.user_id, 'direction', c.direction,
        'duration_sec', c.duration_sec, 'outcome', o.label, 'recording_path', c.recording_path, 'recording_status', c.recording_status) order by c.started_at desc)
      from (select * from public.calls where lead_id = s.lead_id order by started_at desc limit 30) c left join public.call_outcomes o on o.id = c.outcome_id), '[]'::jsonb),
    'webinars', coalesce((select jsonb_agg(jsonb_build_object('name', b.name, 'at', b.webinar_at, 'watch', bl.watch_minutes, 'saw_pitch', bl.saw_pitch) order by b.webinar_at)
      from public.batch_leads bl join public.batches b on b.id = bl.batch_id where bl.lead_id = s.lead_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.paid_at) from public.sale_payments p where p.sale_id = s.id), '[]'::jsonb),
    'flags', to_jsonb(flags))
  into res;
  return res;
end $$;

-- Sales list for the dashboard (managers: everyone they manage; others: their own).
create or replace function public.sales_list(p_org uuid, p_from timestamptz, p_to timestamptz, p_status text default null, p_user uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare mgr boolean := public.is_org_manager(p_org); v_users uuid[] := public.visible_user_ids(p_org);
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'sold_at') desc) from (
    select to_jsonb(s) || public.sale_money(s.id) || jsonb_build_object('lead_name', l.name, 'lead_phone', l.phone,
      'flags', case when s.status = 'claimed' then (public.sale_facts(s.id)->'flags') else '[]'::jsonb end) x
    from public.sales s left join public.leads l on l.id = s.lead_id
    where s.org_id = p_org
      and (s.status = 'claimed' or (s.sold_at >= p_from and s.sold_at < p_to))
      and (p_status is null or s.status = p_status)
      and (p_user is null or s.credited_to = p_user or s.claimed_by = p_user)
      and (case when mgr then (s.credited_to = any(v_users) or s.claimed_by = any(v_users) or s.credited_to is null)
                else (s.claimed_by = auth.uid() or s.credited_to = auth.uid()) end)
    limit 2000) t), '[]'::jsonb);
end $$;

-- Totals for the Sales page and the app's "My Sales Revenue" card: verified orders, collected, balance due, pending.
create or replace function public.sales_summary(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare mgr boolean := public.is_org_manager(p_org); v_users uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_users := case when mgr then public.visible_user_ids(p_org) else array[auth.uid()] end;
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  return (with s as (
      select s.*, (public.sale_money(s.id)) m from public.sales s
      where s.org_id = p_org and s.credited_to = any(v_users)
    ), v as (select * from s where status = 'verified' and sold_at >= p_from and sold_at < p_to)
    select jsonb_build_object(
      'verified', (select count(*) from v),
      'order_value', (select coalesce(sum(amount), 0) from v),
      'net', (select coalesce(sum((m->>'net')::numeric), 0) from v),
      'collected', (select coalesce(sum((m->>'paid')::numeric - (m->>'refunded')::numeric), 0) from v),
      'refunded', (select coalesce(sum((m->>'refunded')::numeric), 0) from v),
      'full', (select count(*) from v where m->>'pay_status' = 'full'),
      'part', (select count(*) from v where m->>'pay_status' = 'part'),
      'unpaid', (select count(*) from v where m->>'pay_status' = 'unpaid'),
      'balance_due', (select coalesce(sum((m->>'balance')::numeric), 0) from s where status = 'verified'),
      'balance_orders', (select count(*) from s where status = 'verified' and (m->>'balance')::numeric > 0),
      'pending', (select count(*) from s where status = 'claimed'),
      'pending_value', (select coalesce(sum(amount), 0) from s where status = 'claimed'),
      'rejected', (select count(*) from s where status = 'rejected' and sold_at >= p_from and sold_at < p_to),
      'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', credited_to, 'sales', n, 'net', net, 'collected', col) order by net desc) from (
          select credited_to, count(*) n, sum((m->>'net')::numeric) net, sum((m->>'paid')::numeric - (m->>'refunded')::numeric) col
          from v group by credited_to) x), '[]'::jsonb),
      'locked', coalesce((select jsonb_agg(month order by month) from public.sale_month_locks where org_id = p_org), '[]'::jsonb)));
end $$;

-- ───── Reports count verified sales only ─────
create or replace function public.lead_revenue(p_lead uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(public.sale_net(s.id)), 0) from public.sales s where s.lead_id = p_lead and s.status = 'verified'
$$;

-- Targets, leaderboard and period comparison count verified sales.
CREATE OR REPLACE FUNCTION public.target_progress(p_org uuid, p_from date, p_to date, p_users uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tz text; v_users uuid[]; v_days int; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'Choose up to 3 months'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  v_days := public.working_days(p_org, null, p_from, p_to);

  with people as (
    select m.user_id, public.working_days(p_org, m.user_id, p_from, p_to) days
    from public.org_members m where m.org_id = p_org and m.status = 'active' and m.user_id = any(v_users)
  ), t as (
    select p.user_id, p.days,
      coalesce(r.calls, d.calls) as calls, coalesce(r.conversations, d.conversations) as conversations,
      coalesce(r.talk_minutes, d.talk_minutes) as talk_minutes, coalesce(r.sales, d.sales) as sales, coalesce(r.focus_leads, d.focus_leads) as focus,
      r.id is not null as own
    from people p
    left join public.rep_targets r on r.org_id = p_org and r.user_id = p.user_id
    left join public.rep_targets d on d.org_id = p_org and d.user_id is null
  ), a as (
    select c.user_id,
      count(*) filter (where c.direction = 'outgoing') as calls,
      count(*) filter (where c.duration_sec > 0) as conversations,
      coalesce(sum(c.duration_sec), 0) / 60 as talk_minutes,
      count(*) filter (where o.category = 'won') as sales
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.user_id = any(v_users)
      and c.started_at >= (p_from::timestamp at time zone v_tz) and c.started_at < ((p_to + 1)::timestamp at time zone v_tz)
    group by c.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'own_target', t.own, 'work_days', t.days,
      'target', jsonb_build_object('calls', t.calls * t.days, 'conversations', t.conversations * t.days,
                                   'talk_minutes', t.talk_minutes * t.days, 'sales', t.sales * t.days),
      'daily', jsonb_build_object('calls', t.calls, 'conversations', t.conversations, 'talk_minutes', t.talk_minutes, 'sales', t.sales, 'focus', t.focus),
      'actual', jsonb_build_object('calls', coalesce(a.calls, 0), 'conversations', coalesce(a.conversations, 0),
                                   'talk_minutes', coalesce(a.talk_minutes, 0),
                                   -- verified sales credited to this person (not just "won" outcomes)
                                   'sales', (select count(*) from public.sales vs where vs.org_id = p_org and vs.credited_to = t.user_id and vs.status = 'verified'
                                     and vs.sold_at >= (p_from::timestamp at time zone v_tz) and vs.sold_at < ((p_to + 1)::timestamp at time zone v_tz)))
    )), '[]'::jsonb) into res
  from t left join a on a.user_id = t.user_id;
  return jsonb_build_object('work_days', v_days, 'rows', res);
end $function$;

CREATE OR REPLACE FUNCTION public.leaderboard(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if coalesce((select (settings->>'show_leaderboard')::boolean from public.organizations where id = p_org), true) = false
     and not public.is_org_manager(p_org) then return '[]'; end if;
  select coalesce(jsonb_agg(x order by (x->>'talk_sec')::int desc), '[]') into res from (
    select jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1)),
      'calls', count(c.id) filter (where c.direction = 'outgoing'),
      'conversations', count(c.id) filter (where c.duration_sec > 0),
      'talk_sec', coalesce(sum(c.duration_sec), 0),
      'sales', (select count(*) from public.sales vs where vs.org_id = p_org and vs.credited_to = m.user_id and vs.status = 'verified'
        and vs.sold_at >= p_from and vs.sold_at < p_to)) as x
    from public.org_members m join public.profiles p on p.id = m.user_id
    left join public.calls c on c.user_id = m.user_id and c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
    left join public.call_outcomes o on o.id = c.outcome_id
    where m.org_id = p_org and m.status = 'active'
    group by m.user_id, m.role, p.full_name, p.email
    having m.role in ('rep', 'manager') or count(c.id) > 0) t;
  return res;
end $function$;

CREATE OR REPLACE FUNCTION public.period_summary(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_users uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '24MB'
AS $function$
declare v_tz text; v_users uuid[]; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if p_to <= p_from then raise exception 'The end date must be after the start date'; end if;
  if p_to - p_from > interval '93 days' then raise exception 'Choose a period of at most 3 months'; end if;
  select timezone into v_tz from public.organizations where id = p_org;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then
    v_users := array(select unnest(v_users) intersect select unnest(p_users));
  end if;

  with c as (
    select c.user_id, c.phone, c.lead_id, c.direction, c.duration_sec,
      (c.started_at at time zone v_tz)::date as day,
      c.direction in ('incoming', 'outgoing') and c.duration_sec > 0 as talked,
      o.category = 'won' as won,
      case when o.category = 'won' then coalesce(nullif(regexp_replace(coalesce(c.outcome_data->>'amount', c.outcome_data->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric, 0) else 0 end as amount,
      c.direction in ('missed', 'rejected') and not exists (
        select 1 from public.calls r where r.org_id = p_org and r.phone = c.phone and r.started_at > c.started_at
          and (r.direction = 'outgoing' or (r.direction = 'incoming' and r.duration_sec > 0))) as never_attended
    from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
    where c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to and c.user_id = any(v_users)
  ),
  ca as (
    select grouping(user_id) as g, user_id,
      count(*) as calls,
      count(*) filter (where direction = 'outgoing') as dialled,
      count(*) filter (where direction = 'outgoing' and duration_sec > 0) as picked,
      count(*) filter (where direction = 'outgoing' and duration_sec = 0) as not_picked,
      count(*) filter (where direction = 'incoming') as received,
      count(*) filter (where direction in ('missed', 'rejected')) as missed,
      count(*) filter (where never_attended) as never_attended,
      count(*) filter (where talked) as conversations,
      coalesce(sum(duration_sec) filter (where talked), 0) as talk_sec,
      count(distinct phone) as uniq_numbers,
      count(distinct phone) filter (where talked) as uniq_reached,
      count(distinct lead_id) filter (where talked) as leads_reached,
      count(distinct lead_id) filter (where direction = 'outgoing') as leads_dialled,
      count(distinct day) as active_days,
      -- verified sales only (credited team member), revenue = order value − refunds
      case when grouping(user_id) = 1 then (select count(*) from public.sales vs where vs.org_id = p_org and vs.status = 'verified' and vs.credited_to = any(v_users) and vs.sold_at >= p_from and vs.sold_at < p_to)
           else (select count(*) from public.sales vs where vs.org_id = p_org and vs.status = 'verified' and vs.credited_to = c.user_id and vs.sold_at >= p_from and vs.sold_at < p_to) end as sales,
      case when grouping(user_id) = 1 then (select coalesce(sum(public.sale_net(vs.id)), 0) from public.sales vs where vs.org_id = p_org and vs.status = 'verified' and vs.credited_to = any(v_users) and vs.sold_at >= p_from and vs.sold_at < p_to)
           else (select coalesce(sum(public.sale_net(vs.id)), 0) from public.sales vs where vs.org_id = p_org and vs.status = 'verified' and vs.credited_to = c.user_id and vs.sold_at >= p_from and vs.sold_at < p_to) end as revenue
    from c group by grouping sets ((), (user_id))
  ),
  l as (
    select grouping(assigned_to) as g, assigned_to as user_id,
      count(*) filter (where assigned_at >= p_from and assigned_at < p_to) as assigned,
      count(*) filter (where assigned_at >= p_from and assigned_at < p_to and dial_count > 0) as assigned_called,
      count(*) filter (where first_dialled_at >= p_from and first_dialled_at < p_to) as new_called,
      percentile_cont(0.5) within group (order by response_sec) filter (where first_dialled_at >= p_from and first_dialled_at < p_to and is_live and response_sec is not null) as response_median_sec
    from public.leads
    where org_id = p_org and deleted_at is null and assigned_to = any(v_users)
      and ((assigned_at >= p_from and assigned_at < p_to) or (first_dialled_at >= p_from and first_dialled_at < p_to))
    group by grouping sets ((), (assigned_to))
  ),
  f as (
    select grouping(assigned_to) as g, assigned_to as user_id,
      count(*) as fu_due,
      count(*) filter (where dialled_at is not null and dialled_at <= due_at + interval '15 minutes') as fu_on_time,
      count(*) filter (where dialled_at is not null and dialled_at > due_at + interval '15 minutes') as fu_late
    from public.follow_ups
    where org_id = p_org and due_at >= p_from and due_at < least(p_to, now() - interval '15 minutes')
      and status <> 'cancelled' and assigned_to = any(v_users)
    group by grouping sets ((), (assigned_to))
  ),
  allrows as (
    select coalesce(ca.g, l.g, f.g) as g, coalesce(ca.user_id, l.user_id, f.user_id) as user_id,
      to_jsonb(ca) - 'g' - 'user_id' as a, to_jsonb(l) - 'g' - 'user_id' as b, to_jsonb(f) - 'g' - 'user_id' as d
    from ca full join l on l.g = ca.g and l.user_id is not distinct from ca.user_id
            full join f on f.g = coalesce(ca.g, l.g) and f.user_id is not distinct from coalesce(ca.user_id, l.user_id)
  )
  select jsonb_build_object(
    'total', coalesce((select coalesce(a, '{}') || coalesce(b, '{}') || coalesce(d, '{}') from allrows where g = 1), '{}'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id) || coalesce(a, '{}') || coalesce(b, '{}') || coalesce(d, '{}'))
                        from allrows where g = 0 and user_id is not null), '[]'::jsonb)
  ) into res;
  return res;
end $function$;

revoke execute on function public.sale_month_locked(uuid, timestamptz) from anon, public;
revoke execute on function public.t_sales_lock() from anon, public, authenticated;
revoke execute on function public.t_sale_won() from anon, public, authenticated;
revoke execute on function public.t_call_sale_claim() from anon, public, authenticated;
revoke execute on function public.claim_sale(uuid, jsonb) from anon, public;
revoke execute on function public.review_sale(uuid, boolean, jsonb) from anon, public;
revoke execute on function public.add_sale_payment(uuid, jsonb) from anon, public;
revoke execute on function public.delete_sale_payment(uuid) from anon, public;
revoke execute on function public.lock_sales_month(uuid, date, boolean) from anon, public;
revoke execute on function public.sale_facts(uuid) from anon, public;
revoke execute on function public.sales_list(uuid, timestamptz, timestamptz, text, uuid) from anon, public;
revoke execute on function public.sales_summary(uuid, timestamptz, timestamptz, uuid[]) from anon, public;
revoke execute on function public.sale_money(uuid) from anon, public;
revoke execute on function public.sale_net(uuid) from anon, public;
grant execute on function public.claim_sale(uuid, jsonb) to authenticated;
grant execute on function public.review_sale(uuid, boolean, jsonb) to authenticated;
grant execute on function public.add_sale_payment(uuid, jsonb) to authenticated;
grant execute on function public.delete_sale_payment(uuid) to authenticated;
grant execute on function public.lock_sales_month(uuid, date, boolean) to authenticated;
grant execute on function public.sale_facts(uuid) to authenticated;
grant execute on function public.sales_list(uuid, timestamptz, timestamptz, text, uuid) to authenticated;
grant execute on function public.sales_summary(uuid, timestamptz, timestamptz, uuid[]) to authenticated;
grant execute on function public.sale_money(uuid) to authenticated;
grant execute on function public.sale_net(uuid) to authenticated;
grant execute on function public.sale_month_locked(uuid, timestamptz) to authenticated;

-- A lead is won by a won outcome OR a verified sale.
CREATE OR REPLACE FUNCTION public.refresh_lead_stats(p_lead uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_last record; v_cat public.outcome_category; v_watch int; v_score numeric := 0; v_dnc boolean; v_lc timestamptz;
begin
  if p_lead is null then return; end if;
  select coalesce(sum(c.duration_sec), 0) talk,
         count(*) all_calls,
         count(*) filter (where c.direction = 'outgoing') dials,
         count(*) filter (where public.is_real_pickup(c.direction, c.duration_sec, o.category)) picks,
         min(c.started_at) filter (where c.direction = 'outgoing') first_dial,
         min(c.started_at) filter (where o.category = 'won') won
    into s
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id where c.lead_id = p_lead;

  select c.direction, c.duration_sec, o.category into v_last
  from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
  where c.lead_id = p_lead order by c.started_at desc limit 1;

  select o.category, l.do_not_call, l.last_connected_at into v_cat, v_dnc, v_lc
  from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id where l.id = p_lead;
  select max(watch_minutes) into v_watch from public.batch_leads where lead_id = p_lead;

  -- Close-to-converting score (open leads only).
  if not coalesce(v_dnc, false) and coalesce(v_cat::text, '') not in ('won', 'lost', 'invalid') then
    v_score := least(s.picks, 3) * 12
             + least(s.talk / 60.0 / 30.0, 1) * 24
             + case v_cat when 'positive' then 20 when 'connected' then 8 else 0 end
             + case when coalesce(v_watch, 0) >= 60 then 15 when coalesce(v_watch, 0) > 0 then 6 else 0 end
             + case when v_lc > now() - interval '3 days' then 5 else 0 end;
  end if;

  update public.leads l set
    total_talk_sec = s.talk, dial_count = s.dials, call_count = s.all_calls, pickup_count = s.picks,
    first_dialled_at = s.first_dial, won_at = least(s.won, (select min(vs.sold_at) from public.sales vs where vs.lead_id = p_lead and vs.status = 'verified')),
    first_talk_dial = (select n from (
        select row_number() over (order by c.started_at) n, public.is_real_pickup(c.direction, c.duration_sec, o.category) p
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = p_lead and c.direction = 'outgoing') x where p order by n limit 1),
    last_call_status = case
        when v_last.direction is null then null
        when v_last.direction in ('missed', 'rejected') then 'missed'
        when v_last.direction = 'incoming' then case when coalesce(v_last.duration_sec, 0) > 0 then 'talked' else 'missed' end
        when public.is_real_pickup(v_last.direction, v_last.duration_sec, v_last.category) then 'talked'
        else 'not_picked' end,
    wa_count = (select count(*) from public.wa_messages w where w.lead_id = p_lead and w.undone_at is null),
    score = round(v_score)::int,
    conversation_count = (select count(*) from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        where c.lead_id = p_lead and (public.is_real_pickup(c.direction, c.duration_sec, o.category)
          or (c.direction = 'incoming' and case when o.category is not null then o.category in ('connected', 'positive', 'won', 'lost') else coalesce(c.duration_sec, 0) >= 20 end))),
    best_hour = (select hr from (
        select extract(hour from c.started_at at time zone coalesce(o2.timezone, 'Asia/Kolkata'))::int hr, count(*) n
        from public.calls c left join public.call_outcomes o on o.id = c.outcome_id
        join public.leads l2 on l2.id = c.lead_id join public.organizations o2 on o2.id = l2.org_id
        where c.lead_id = p_lead and public.is_real_pickup(c.direction, c.duration_sec, o.category)
        group by 1 having count(*) >= 2 order by 2 desc, 1 limit 1) b)
  where l.id = p_lead;
end $function$;

-- FIX (bug since 0071): the record variable "s" clashed with the table alias "s" → saving a won / not-interested outcome
-- failed with "record s is not assigned yet". Variable renamed.
CREATE OR REPLACE FUNCTION public.t_seq_on_call_outcome()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_cat text; r record;
begin
  if new.outcome_id is null or new.lead_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.outcome_id is not distinct from old.outcome_id then return new; end if;
  select category::text into v_cat from public.call_outcomes where id = new.outcome_id;
  if v_cat in ('won', 'lost') then
    update public.wa_sequence_leads e set status = 'stopped', next_due_at = null, updated_at = now(),
      stop_reason = case when v_cat = 'won' then 'Lead bought' else 'Lead not interested' end
    where e.lead_id = new.lead_id and e.status in ('active', 'paused')
      and not exists (select 1 from public.wa_sequences sq where sq.id = e.sequence_id and new.outcome_id = any(sq.start_outcomes));
  end if;
  for r in select id from public.wa_sequences
    where org_id = new.org_id and not is_archived and new.outcome_id = any(start_outcomes)
      and (owner_id is null or owner_id = new.user_id) loop
    perform public.seq_enroll(r.id, new.lead_id, new.user_id, new.batch_id, 'outcome');
  end loop;
  return new;
end $function$;
