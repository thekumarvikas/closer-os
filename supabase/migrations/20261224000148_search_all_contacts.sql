-- Search finds a lead by ANY of its numbers / emails (second contacts from Zoom, re-registrations, imports).
CREATE OR REPLACE FUNCTION public.search_leads(p_org uuid, p_q text, p_limit integer DEFAULT 300)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare q text := lower(trim(coalesce(p_q, ''))); digits text; v_rep boolean; res uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if length(q) < 2 then return '{}'; end if;
  digits := regexp_replace(q, '\D', '', 'g');
  v_rep := public.org_role(p_org) = 'rep';
  select array_agg(id) into res from (
    select id from (
      select l.id, l.updated_at from public.leads l
      where l.org_id = p_org and l.deleted_at is null and public.lead_search_text(l) like '%' || q || '%'
      union
      select l.id, l.updated_at from public.leads l
      where length(digits) >= 4 and l.org_id = p_org and l.deleted_at is null and l.phone like '%' || digits || '%'
      union
      select l.id, l.updated_at from public.lead_phones lp join public.leads l on l.id = lp.lead_id
      where length(digits) >= 4 and lp.org_id = p_org and l.deleted_at is null and lp.phone like '%' || digits || '%'
      union
      select l.id, l.updated_at from public.lead_emails le join public.leads l on l.id = le.lead_id
      where le.org_id = p_org and l.deleted_at is null and position('@' in q) > 0 and lower(le.email) like '%' || q || '%'
      union
      select l.id, l.updated_at from public.leads l
      where l.org_id = p_org and l.deleted_at is null and position('@' in q) > 0 and lower(l.email) like '%' || q || '%'
      union
      select l.id, l.updated_at from public.lead_activities a join public.leads l on l.id = a.lead_id
      where a.kind = 'note' and a.org_id = p_org and lower(a.data->>'text') like '%' || q || '%' and l.deleted_at is null
      union
      select l.id, l.updated_at from public.calls c join public.leads l on l.id = c.lead_id
      where c.org_id = p_org and c.notes is not null and lower(c.notes) like '%' || q || '%' and l.deleted_at is null
    ) m
    where not v_rep or exists (select 1 from public.leads x where x.id = m.id and (x.assigned_to = auth.uid() or auth.uid() = any(x.shared_with)
          or exists (select 1 from public.batch_leads b where b.lead_id = x.id and b.reminder_by = auth.uid())))
    order by updated_at desc limit p_limit) t;
  return coalesce(res, '{}');
end $function$
;
