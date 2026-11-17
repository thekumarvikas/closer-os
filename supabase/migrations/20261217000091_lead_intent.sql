-- Round 15 · 4) "Where is this lead?" — a practical buying-intent level a rep sets with one tap.
-- Owner: Hot / Warm / Cold is too generic for a pro sales app. Default levels (companies edit them in
-- Settings → organizations.settings.intent_levels = [{key, label, short, color}]; keys are what leads store):
--   ready · hot · interested · approval · price · later · cold · nofit
-- leads.intent holds the key; intent_at / intent_by say when and who; each change is a lead activity.

alter table public.leads add column if not exists intent text;
alter table public.leads add column if not exists intent_at timestamptz;
alter table public.leads add column if not exists intent_by uuid references auth.users(id) on delete set null;
create index if not exists leads_org_intent on public.leads (org_id, intent) where deleted_at is null and intent is not null;

-- Sets (or clears, with null) the level. Anyone who can see the lead.
create or replace function public.set_lead_intent(p_lead uuid, p_intent text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text; v_org uuid; v_new text := nullif(trim(coalesce(p_intent, '')), '');
begin
  select intent, org_id into v_old, v_org from public.leads where id = p_lead and deleted_at is null;
  if v_org is null or not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  if v_new is not null and length(v_new) > 40 then raise exception 'Unknown level'; end if;
  if v_old is not distinct from v_new then return; end if;
  update public.leads set intent = v_new, intent_at = now(), intent_by = auth.uid(), updated_at = now() where id = p_lead;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (v_org, p_lead, auth.uid(), 'intent', jsonb_build_object('from', v_old, 'to', v_new));
end $$;
revoke execute on function public.set_lead_intent(uuid, text) from anon, public;
grant execute on function public.set_lead_intent(uuid, text) to authenticated;

-- How many leads sit at each level (dashboard chips with counts). Respects who can see what.
create or replace function public.lead_intent_counts(p_org uuid, p_assignee uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_object_agg(coalesce(intent, ''), n), '{}'::jsonb) from (
    select intent, count(*) n from public.leads
    where org_id = p_org and deleted_at is null and (p_assignee is null or assigned_to = p_assignee)
    group by intent) x
$$;
grant execute on function public.lead_intent_counts(uuid, uuid) to authenticated;
