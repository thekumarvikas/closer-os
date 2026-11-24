-- Leads saved as contacts on each rep's phone (owner, Nov 24 2026).
-- Who: leads assigned to me, shared with me, and leads I remind for a webinar that isn't over yet (until 3 h after start).
-- Managers / admins / owners of a company get none (their phones stay clean); a personal account's owner gets all of theirs.
create or replace function public.my_contact_leads(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_role text; v_ind boolean; v_tz text;
begin
  if v_me is null or not public.is_org_member(p_org) then return '[]'::jsonb; end if;
  select role::text into v_role from public.org_members where org_id = p_org and user_id = v_me;
  select coalesce(is_individual, false), coalesce(timezone, 'Asia/Kolkata') into v_ind, v_tz from public.organizations where id = p_org;
  if not v_ind and v_role in ('owner', 'admin', 'manager') then return '[]'::jsonb; end if;
  return coalesce((
    with mine as (
      select l.id, coalesce(l.assigned_at, l.created_at) as saved_at from public.leads l
        where l.org_id = p_org and l.deleted_at is null and l.assigned_to = v_me
      union all
      select s.lead_id, s.created_at from public.lead_shares s join public.leads l on l.id = s.lead_id and l.deleted_at is null
        where s.user_id = v_me and l.org_id = p_org
      union all
      select bl.lead_id, coalesce(l.assigned_at, l.created_at) from public.batch_leads bl join public.batches b on b.id = bl.batch_id
        join public.leads l on l.id = bl.lead_id and l.deleted_at is null
        where bl.reminder_by = v_me and l.org_id = p_org and b.webinar_at > now() - interval '3 hours'
    ), one as (select id, min(saved_at) saved_at from mine group by id)
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'profession', l.profession, 'city', l.city,
      'saved_at', one.saved_at, 'intent', l.intent, 'last_note', l.last_note, 'last_note_at', l.last_note_at,
      'updated_at', l.updated_at,
      'webinar', (select jsonb_build_object('at', b.webinar_at, 'min', bl.watch_minutes) from public.batch_leads bl
                    join public.batches b on b.id = bl.batch_id where bl.lead_id = l.id order by b.webinar_at desc limit 1),
      'buyer', (select jsonb_build_object('product', coalesce(p.name, s.product, 'a product'), 'at', s.sold_at,
                    'more', (select count(*) - 1 from public.sales s2 where s2.lead_id = l.id and s2.status = 'verified'))
                  from public.sales s left join public.products p on p.id = s.product_id
                  where s.lead_id = l.id and s.status = 'verified' order by s.sold_at desc limit 1)
    )) from one join public.leads l on l.id = one.id), '[]'::jsonb);
end $$;
revoke all on function public.my_contact_leads(uuid) from public, anon;
grant execute on function public.my_contact_leads(uuid) to authenticated;

-- Reassigning / sharing wakes the phones involved so their contacts update within a minute (one push per person, not per lead).
create or replace function public.t_contacts_wake() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct org_id, u from (
      select n.org_id, n.assigned_to u from new_rows n join old_rows o on o.id = n.id where n.assigned_to is distinct from o.assigned_to
      union select o.org_id, o.assigned_to from new_rows n join old_rows o on o.id = n.id where n.assigned_to is distinct from o.assigned_to
      union select n.org_id, n.assigned_to from new_rows n join old_rows o on o.id = n.id where n.deleted_at is not null and o.deleted_at is null
    ) x where u is not null limit 60
  loop perform public.push_wake(r.org_id, r.u, 'contacts'); end loop;
  return null;
end $$;
drop trigger if exists t_contacts_wake on public.leads;
create trigger t_contacts_wake after update on public.leads referencing new table as new_rows old table as old_rows
  for each statement execute function public.t_contacts_wake();
