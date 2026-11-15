-- App saves with no internet: a scheduled WhatsApp message gets its id on the phone (p_new_id), so it can be
-- created offline and sent later; sending the same one twice changes nothing.
drop function if exists public.schedule_wa(uuid, timestamptz, text, jsonb, uuid);
create or replace function public.schedule_wa(p_lead uuid, p_due timestamptz, p_body text, p_media jsonb default null,
  p_id uuid default null, p_new_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  select org_id into v_org from public.leads where id = p_lead;
  if v_org is null or not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  if coalesce(trim(p_body), '') = '' and coalesce(p_media->>'path', '') = '' then raise exception 'Write the message first'; end if;
  if p_id is not null then
    update public.wa_scheduled set due_at = p_due, body = coalesce(p_body, ''), media_path = nullif(p_media->>'path', ''),
      media_type = nullif(p_media->>'type', ''), media_name = nullif(p_media->>'name', '')
    where id = p_id and user_id = auth.uid() and status = 'pending' returning id into v_id;
    if v_id is null then raise exception 'Scheduled message not found'; end if;
    return v_id;
  end if;
  insert into public.wa_scheduled (id, org_id, lead_id, due_at, body, media_path, media_type, media_name)
  values (coalesce(p_new_id, gen_random_uuid()), v_org, p_lead, p_due, coalesce(p_body, ''), nullif(p_media->>'path', ''),
    nullif(p_media->>'type', ''), nullif(p_media->>'name', ''))
  on conflict (id) do nothing
  returning id into v_id;
  return coalesce(v_id, p_new_id);
end $$;
revoke execute on function public.schedule_wa(uuid, timestamptz, text, jsonb, uuid, uuid) from anon, public;
grant execute on function public.schedule_wa(uuid, timestamptz, text, jsonb, uuid, uuid) to authenticated;

-- A sale saved by an owner / admin / manager, or in a personal (individual) account, counts at once: nobody else
-- has to check it. Reps' sales still wait for a manager.
create or replace function public.sale_auto_verified(p_org uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_individual from public.organizations where id = p_org), false)
      or exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user
                   and m.role in ('owner', 'admin', 'manager'))
$$;
revoke execute on function public.sale_auto_verified(uuid, uuid) from anon, public, authenticated;

create or replace function public.t_call_sale_claim() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cat text; v_amount numeric; v_prod text; v_pid uuid; v_auto boolean;
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
    case when v_auto then new.user_id end, case when v_auto then now() end);
  return new;
exception when others then
  return new;   -- never block saving a call (e.g. locked month): the manager can add the sale by hand
end $$;
revoke execute on function public.t_call_sale_claim() from anon, public, authenticated;

-- Claims made by a personal account are counted at once too (owners are already managers; this covers old rows).
update public.sales s set status = 'verified', verified_by = s.claimed_by, verified_at = now()
where s.status = 'claimed' and s.dup_of is null and public.sale_auto_verified(s.org_id, s.claimed_by);
