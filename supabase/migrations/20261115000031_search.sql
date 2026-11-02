-- Search leads by name, phone, email, company, profession, city, the company's own fields (custom),
-- key facts, imported notes, notes and call notes. Returns ids of leads the user may see.
create extension if not exists pg_trgm with schema extensions;

create or replace function public.search_leads(p_org uuid, p_q text, p_limit int default 300)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(trim(coalesce(p_q, ''))); digits text; v_rep boolean; res uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if length(q) < 2 then return '{}'; end if;
  digits := regexp_replace(q, '\D', '', 'g');
  v_rep := public.org_role(p_org) = 'rep';
  select array_agg(id) into res from (
    select l.id from public.leads l
    where l.org_id = p_org and l.deleted_at is null
      and (not v_rep or l.assigned_to = auth.uid() or exists (select 1 from public.batch_leads b where b.lead_id = l.id and b.reminder_by = auth.uid()))
      and (
        (length(digits) >= 4 and l.phone like '%' || digits || '%')
        or lower(coalesce(l.name, '') || ' ' || coalesce(l.email, '') || ' ' || coalesce(l.company, '') || ' ' || coalesce(l.profession, '') || ' ' ||
                 coalesce(l.city, '') || ' ' || coalesce(l.state, '') || ' ' || coalesce(l.source, '') || ' ' || coalesce(l.campaign, '') || ' ' ||
                 coalesce(l.key_facts, '') || ' ' || coalesce(l.notes, '') || ' ' || coalesce(l.custom::text, '')) like '%' || q || '%'
        or exists (select 1 from public.lead_activities a where a.lead_id = l.id and a.kind = 'note' and lower(a.data->>'text') like '%' || q || '%')
        or exists (select 1 from public.calls c where c.lead_id = l.id and c.notes is not null and lower(c.notes) like '%' || q || '%')
      )
    order by l.updated_at desc limit p_limit) t;
  return coalesce(res, '{}');
end $$;
revoke execute on function public.search_leads(uuid, text, int) from anon, public;
grant execute on function public.search_leads(uuid, text, int) to authenticated;

-- People I can see (for report filters in the app).
create or replace function public.team_brief(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(p.full_name, ''), p.email)) order by p.full_name), '[]')
  from public.org_members m join public.profiles p on p.id = m.user_id
  where m.org_id = p_org and m.status = 'active' and m.user_id = any(public.visible_user_ids(p_org)) and public.is_org_member(p_org)
$$;
revoke execute on function public.team_brief(uuid) from anon, public;
grant execute on function public.team_brief(uuid) to authenticated;
