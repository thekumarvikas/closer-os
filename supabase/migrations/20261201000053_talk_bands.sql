-- Leads grouped by total talk time with the lead (leads.total_talk_sec).
-- Runs as the caller, so reps only count the leads they can see.
create or replace function public.lead_talk_bands(p_org uuid, p_assignee text default null)
returns table(band text, leads bigint)
language sql stable security invoker set search_path = public as $$
  with l as (
    select coalesce(total_talk_sec, 0) t from leads
    where org_id = p_org and deleted_at is null
      and (p_assignee is null or p_assignee = ''
           or (p_assignee = 'none' and assigned_to is null)
           or assigned_to::text = p_assignee)
  )
  select b.band, (select count(*) from l where l.t >= b.lo and (b.hi is null or l.t < b.hi))
  from (values ('none', 0, 1), ('u1', 1, 60), ('m1_5', 60, 300), ('m5_15', 300, 900),
               ('m15_30', 900, 1800), ('m30', 1800, null)) b(band, lo, hi);
$$;
grant execute on function public.lead_talk_bands(uuid, text) to authenticated;
create index if not exists leads_org_talk on leads(org_id, total_talk_sec) where deleted_at is null;
