-- Playbook: call scripts, objection answers, important links and documents, managed by the company
-- and shown in the app. Reps can suggest items; they go live after a manager approves.
create table if not exists public.playbook_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('script', 'objection', 'link', 'doc')),
  section text,                       -- free grouping, e.g. "Opening", "Price", "Payment links"
  title text not null,
  body text,
  url text,
  purpose text not null default 'both' check (purpose in ('sales', 'reminder', 'both')),
  position int not null default 0,
  status text not null default 'published' check (status in ('published', 'pending', 'rejected', 'archived')),
  review_note text,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists playbook_org_idx on public.playbook_items (org_id, kind, position);
alter table public.playbook_items enable row level security;

drop policy if exists playbook_select on public.playbook_items;
create policy playbook_select on public.playbook_items for select using (
  public.is_org_member(org_id) and (status = 'published' or created_by = auth.uid() or public.is_org_manager(org_id))
);
-- Managers write anything; reps can only add suggestions (pending) and edit their own pending ones.
drop policy if exists playbook_insert on public.playbook_items;
create policy playbook_insert on public.playbook_items for insert with check (
  public.is_org_member(org_id) and created_by = auth.uid() and (public.is_org_manager(org_id) or status = 'pending')
);
drop policy if exists playbook_update on public.playbook_items;
create policy playbook_update on public.playbook_items for update
  using (public.is_org_manager(org_id) or (created_by = auth.uid() and status = 'pending'))
  with check (public.is_org_manager(org_id) or (created_by = auth.uid() and status = 'pending'));
drop policy if exists playbook_delete on public.playbook_items;
create policy playbook_delete on public.playbook_items for delete
  using (public.is_org_manager(org_id) or (created_by = auth.uid() and status = 'pending'));

create or replace function public.review_playbook_item(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.playbook_items where id = p_id;
  if v_org is null or not public.is_org_manager(v_org) then raise exception 'Only managers can approve'; end if;
  update public.playbook_items set status = case when p_approve then 'published' else 'rejected' end,
    review_note = nullif(trim(p_note), ''), approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = p_id;
end $$;
revoke execute on function public.review_playbook_item(uuid, boolean, text) from anon, public;
grant execute on function public.review_playbook_item(uuid, boolean, text) to authenticated;

-- A starter playbook for every company (they edit or delete it).
create or replace function public.seed_playbook(p_org uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.playbook_items (org_id, kind, section, title, body, purpose, position)
  select p_org, k, s, t, b, pu, pos from (values
    ('script', 'Opening', 'Sales call opening', 'Hi {{leadName}}, this is {{repName}} from {{companyName}}. You attended our session {{batchName}} — I wanted to ask what you liked most and answer any questions. Do you have 2 minutes?', 'sales', 1),
    ('script', 'Reminder', 'Webinar reminder', 'Hi {{leadName}}, {{repName}} here from {{companyName}}. Just a reminder that {{batchName}} starts {{batchDate}}. Shall I send you the joining link on WhatsApp?', 'reminder', 2),
    ('script', 'Closing', 'Closing the sale', 'Based on what you told me, this is a good fit for you. Shall I share the payment link now so you get the early-bird price?', 'sales', 3),
    ('objection', 'Price', '"It is too expensive"', 'Agree, then compare: "I understand. If this helps you earn even one extra client a month, it pays for itself. We also have an EMI option — shall I explain?"', 'sales', 1),
    ('objection', 'Time', '"I don''t have time"', '"That''s exactly why the programme is designed in 30-minute sessions you can watch anytime. When do you usually have a free half hour?"', 'sales', 2),
    ('objection', 'Family', '"I need to ask my family"', '"Of course. What questions do you think they will have? I can send a short summary on WhatsApp you can show them — and we can talk again tomorrow evening."', 'sales', 3)
  ) v(k, s, t, b, pu, pos)
  where not exists (select 1 from public.playbook_items where org_id = p_org);
$$;
select public.seed_playbook(id) from public.organizations;

-- New companies get it too.
create or replace function public.after_org_created_playbook() returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.seed_playbook(new.id); return new; end $$;
drop trigger if exists t_org_playbook on public.organizations;
create trigger t_org_playbook after insert on public.organizations for each row execute function public.after_org_created_playbook();
