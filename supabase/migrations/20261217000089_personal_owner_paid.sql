-- Round 15 · 2) Leads with no owner, and personal sales shown as unpaid.
--
-- a) The app saves a lead "added from a call" without naming its owner and relied on
--    prepare_lead, which fills the owner in only for reps. Personal-account owners and
--    company managers were left with an ownerless lead (17 personal, 10 company), and
--    every "my leads" report skipped it — Sales insights showed nothing although the
--    sale was there. Now: in a personal account every lead belongs to its owner; in a
--    company a lead added from a call belongs to the person whose call it was.
-- b) A sale added in a personal account had no payment row, so the whole amount
--    showed as "still to be paid". A personal sale now counts as fully paid unless it
--    is marked as a part payment.

-- ───── a) Owner chosen before the row is written ─────
create or replace function public.t_lead_route() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_solo boolean;
begin
  if new.assigned_to is not null then return new; end if;
  select o.is_individual into v_solo from public.organizations o where o.id = new.org_id;
  if coalesce(v_solo, false) then
    select m.user_id into v_user from public.org_members m
     where m.org_id = new.org_id and m.status = 'active' order by (m.role = 'owner') desc, m.joined_at limit 1;
  elsif coalesce(new.source, '') = 'Phone call' and auth.uid() is not null
        and exists (select 1 from public.org_members m where m.org_id = new.org_id and m.user_id = auth.uid() and m.status = 'active') then
    v_user := auth.uid();
  elsif coalesce(current_setting('closeros.skip_distribution', true), '') <> 'on' then
    v_user := public.pick_assignee(new.org_id, new);
  end if;
  if v_user is not null then
    new.assigned_to := v_user;
    new.assigned_at := now();
  end if;
  return new;
end $$;

-- Repair: personal accounts — every lead is the owner's.
update public.leads l set assigned_to = m.user_id
from public.organizations o,
     lateral (select x.user_id from public.org_members x where x.org_id = o.id and x.status = 'active'
              order by (x.role = 'owner') desc, x.joined_at limit 1) m
where o.id = l.org_id and o.is_individual and l.assigned_to is null and l.deleted_at is null;

-- Repair: companies — a lead added from a call belongs to whoever added it (if still in the team).
update public.leads l set assigned_to = l.created_by
where l.source = 'Phone call' and l.assigned_to is null and l.deleted_at is null and l.created_by is not null
  and exists (select 1 from public.org_members m where m.org_id = l.org_id and m.user_id = l.created_by and m.status = 'active')
  and not exists (select 1 from public.organizations o where o.id = l.org_id and o.is_individual);

-- ───── b) Personal sales count as paid ─────
CREATE OR REPLACE FUNCTION public.claim_sale(p_lead uuid, p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid; v_id uuid; v_pid uuid := nullif(p->>'product_id', '')::uuid; v_prod text := nullif(trim(p->>'product'), '');
  v_amount numeric := nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric; mgr boolean;
  v_solo boolean; v_paid numeric := nullif(regexp_replace(coalesce(p->>'paid', ''), '[^0-9.]', '', 'g'), '')::numeric;
begin
  select l.org_id, o.is_individual into v_org, v_solo from public.leads l join public.organizations o on o.id = l.org_id
   where l.id = p_lead and l.deleted_at is null;
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
  -- A personal sale is paid in full unless it's marked as a part payment.
  if v_paid is null and coalesce(v_solo, false) and not coalesce((p->>'part')::boolean, false) then v_paid := v_amount; end if;
  if mgr and coalesce(v_paid, 0) > 0 then
    insert into public.sale_payments (org_id, sale_id, amount, method, paid_at, reference, added_by)
    values (v_org, v_id, least(v_paid, v_amount), coalesce(nullif(p->>'method', ''), case when v_solo then 'other' else 'upi' end),
      coalesce(nullif(p->>'sold_at', '')::timestamptz, now()), nullif(trim(p->>'reference'), ''), auth.uid());
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (v_org, p_lead, auth.uid(), 'sale_claimed', jsonb_build_object('sale_id', v_id, 'amount', v_amount, 'product', v_prod));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.t_call_sale_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cat text; v_amount numeric; v_prod text; v_pid uuid; v_auto boolean; v_sid uuid; v_solo boolean;
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
  v_auto := public.sale_auto_verified(new.org_id, new.user_id);
  insert into public.sales (org_id, lead_id, product_id, product, amount, sold_at, status, source, claimed_by, credited_to, call_id,
    verified_by, verified_at)
  values (new.org_id, new.lead_id, v_pid, v_prod, v_amount, coalesce(new.ended_at, new.started_at, now()),
    case when v_auto then 'verified' else 'claimed' end, 'outcome', new.user_id, new.user_id, new.id,
    case when v_auto then new.user_id end, case when v_auto then now() end)
  returning id into v_sid;
  select is_individual into v_solo from public.organizations where id = new.org_id;
  if coalesce(v_solo, false) and v_amount > 0 and not coalesce((new.outcome_data->>'part')::boolean, false) then
    insert into public.sale_payments (org_id, sale_id, amount, method, paid_at, added_by)
    values (new.org_id, v_sid, v_amount, 'other', coalesce(new.ended_at, new.started_at, now()), new.user_id);
  end if;
  return new;
exception when others then
  return new;   -- never block saving a call (e.g. locked month): the manager can add the sale by hand
end $function$;

-- Repair: personal sales with nothing paid yet count as paid in full.
insert into public.sale_payments (org_id, sale_id, amount, method, paid_at, added_by)
select s.org_id, s.id, s.amount, 'other', s.sold_at, s.claimed_by
from public.sales s join public.organizations o on o.id = s.org_id
where o.is_individual and s.amount > 0 and s.status <> 'rejected'
  and not exists (select 1 from public.sale_payments p where p.sale_id = s.id);
