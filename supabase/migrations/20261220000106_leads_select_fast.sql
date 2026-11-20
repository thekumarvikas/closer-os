-- Reps' phones timed out downloading their leads (Amee Shah, Cancer Consultation Circle: "statement timeout", 3.5 s for
-- 0 rows): the leads_select rule looked up batch_leads THROUGH batch_leads' own security rule (lead_visible per row).
-- Same rule, checked directly.
create or replace function public.lead_reminder_visible(p_org uuid, p_lead uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.batch_leads bl
                 where bl.lead_id = p_lead and bl.reminder_by is not null and public.can_see_user(p_org, bl.reminder_by))
$$;
revoke execute on function public.lead_reminder_visible(uuid, uuid) from public, anon;
grant execute on function public.lead_reminder_visible(uuid, uuid) to authenticated;
create index if not exists batch_leads_reminder_lead on public.batch_leads (lead_id) where reminder_by is not null;

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select using (
  public.is_org_member(org_id) and (
    public.can_see_lead(org_id, assigned_to)
    or auth.uid() = any (shared_with)
    or exists (select 1 from unnest(leads.shared_with) s(u) where public.can_see_user(leads.org_id, s.u))
    or public.lead_reminder_visible(org_id, id)
  )
);
