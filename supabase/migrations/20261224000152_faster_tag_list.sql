-- Leads page tag filter: check membership / manager once, not for every lead (0.8 s → a few ms).
create or replace function public.lead_tag_list(p_org uuid) returns table (tag text, leads int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then return; end if;
  if public.is_org_manager(p_org) then
    return query select t, count(*)::int from public.leads l, unnest(l.tags) t
      where l.org_id = p_org and l.deleted_at is null and cardinality(l.tags) > 0 group by t order by count(*) desc, t limit 300;
  else
    return query select t, count(*)::int from public.leads l, unnest(l.tags) t
      where l.org_id = p_org and l.deleted_at is null and cardinality(l.tags) > 0 and public.lead_visible(l.id) group by t order by count(*) desc, t limit 300;
  end if;
end $$;
revoke execute on function public.lead_tag_list(uuid) from anon, public;
grant execute on function public.lead_tag_list(uuid) to authenticated;
