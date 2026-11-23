-- Sales ↔ price list (owner, Nov 23 2026): product name and product_id always kept together; edit + bulk edit.
create or replace function public.t_sale_product() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.product_id is not null and (tg_op = 'INSERT' or new.product_id is distinct from old.product_id) then
    select name into new.product from public.products where id = new.product_id;
  elsif new.product is not null and (new.product_id is null or (tg_op = 'UPDATE' and new.product is distinct from old.product and new.product_id is not distinct from old.product_id)) then
    new.product_id := (select id from public.products where org_id = new.org_id and lower(trim(name)) = lower(trim(new.product)) limit 1);
  end if;
  return new;
end $$;
drop trigger if exists t_sale_product on public.sales;
create trigger t_sale_product before insert or update of product, product_id on public.sales for each row execute function public.t_sale_product();
-- old rows: fill whichever side is missing
update public.sales s set product = p.name from public.products p where s.product_id = p.id and s.product is null;
update public.sales s set product_id = p.id from public.products p where s.product_id is null and s.product is not null and p.org_id = s.org_id and lower(trim(p.name)) = lower(trim(s.product));

create or replace function public.update_sale(p_sale uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or not public.is_org_manager(s.org_id) then raise exception 'Only managers can edit sales'; end if;
  update public.sales set
    product_id = case when p ? 'product_id' then nullif(p->>'product_id', '')::uuid else product_id end,
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

-- Bulk edit: the same change for many sales at once (only the fields sent change).
create or replace function public.bulk_update_sales(p_ids uuid[], p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_id uuid; n int := 0;
begin
  foreach v_id in array p_ids loop
    if p ? 'delete' then perform public.delete_sale(v_id); else perform public.update_sale(v_id, p); end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.bulk_update_sales(uuid[], jsonb) from public, anon;
grant execute on function public.bulk_update_sales(uuid[], jsonb) to authenticated;
