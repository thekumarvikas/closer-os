-- Buyers of one or more imports with their details and the lead they matched (owner: show names + details, not only reasons).
create or replace function public.buyer_import_rows(p_imports uuid[])
returns table(row_no int, name text, phone text, email text, product text, amount numeric, paid numeric, sold_at timestamptz,
              match_how text, lead_id uuid, lead_name text, lead_phone text, credited_to uuid, status text, extra jsonb, import_id uuid)
language sql stable security definer set search_path = '' as $$
  select (s.buyer->>'row')::int, coalesce(s.buyer->>'name', ''), coalesce(s.buyer->>'phone', s.buyer->>'phone_typed', ''),
         coalesce(s.buyer->>'email', s.buyer->>'email_typed', ''), coalesce(s.product, pr.name, ''), s.amount,
         coalesce((select sum(case when sp.kind = 'refund' then -sp.amount else sp.amount end) from public.sale_payments sp where sp.sale_id = s.id), 0),
         s.sold_at, coalesce(s.match_how, 'none'), s.lead_id, l.name, l.phone, s.credited_to, s.status::text,
         coalesce(s.buyer->'extra', '{}'), s.import_id
  from public.sales s
  join public.buyer_imports bi on bi.id = s.import_id
  left join public.leads l on l.id = s.lead_id
  left join public.products pr on pr.id = s.product_id
  where s.import_id = any(p_imports) and (public.is_org_admin(bi.org_id) or public.is_org_manager(bi.org_id))
  order by (s.buyer->>'row')::int nulls last
$$;
revoke all on function public.buyer_import_rows(uuid[]) from public, anon;
grant execute on function public.buyer_import_rows(uuid[]) to authenticated;
