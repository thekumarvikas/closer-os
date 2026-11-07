-- Phones copy management-made content (playbook, templates, files, outcomes, profession groups, webinars,
-- targets) only when it changes: every change bumps a small per-company counter; the phone asks
-- content_versions(org) — one tiny call — and downloads only the parts whose counter moved.

create table if not exists public.org_content_versions (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  v bigint not null default 1,
  changed_at timestamptz not null default now(),
  primary key (org_id, key)
);
alter table public.org_content_versions enable row level security;
drop policy if exists content_versions_read on public.org_content_versions;
create policy content_versions_read on public.org_content_versions for select to authenticated using (public.is_org_member(org_id));

create or replace function public.t_bump_content() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  v_org := case when tg_table_name = 'organizations' then coalesce(new.id, old.id)
                else (case when tg_op = 'DELETE' then old.org_id else new.org_id end) end;
  if v_org is not null then
    insert into public.org_content_versions (org_id, key) values (v_org, tg_argv[0])
    on conflict (org_id, key) do update set v = org_content_versions.v + 1, changed_at = now();
  end if;
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from (values ('playbook_items', 'playbook'), ('message_templates', 'templates'), ('company_files', 'files'),
                                 ('profession_categories', 'categories'), ('call_outcomes', 'outcomes'), ('batches', 'batches'),
                                 ('rep_targets', 'targets'), ('org_holidays', 'targets'), ('member_leave', 'targets')) x(tbl, k) loop
    execute format('drop trigger if exists t_bump_content on public.%I', t.tbl);
    execute format('create trigger t_bump_content after insert or update or delete on public.%I for each row execute function public.t_bump_content(%L)', t.tbl, t.k);
  end loop;
end $$;
-- Company settings (working days, check-ins, note tags…) — only when settings really change.
drop trigger if exists t_bump_content on public.organizations;
create trigger t_bump_content after update of settings, timezone, name on public.organizations
  for each row when (old.settings is distinct from new.settings or old.timezone is distinct from new.timezone or old.name is distinct from new.name)
  execute function public.t_bump_content('settings');

create or replace function public.content_versions(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.is_org_member(p_org)
    then coalesce((select jsonb_object_agg(key, v) from public.org_content_versions where org_id = p_org), '{}'::jsonb) end;
$$;
revoke execute on function public.content_versions(uuid) from anon, public;
grant execute on function public.content_versions(uuid) to authenticated;

-- Outcomes of MY calls that changed since a moment (saved on the laptop, by a teammate on a shared lead…).
create index if not exists calls_user_updated on public.calls (org_id, user_id, updated_at);

-- Playing a recording is allowed (and audited) for anyone who can see the lead (shared / reassigned leads too).
create or replace function public.log_recording_access(p_call uuid, p_action text default 'play')
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_user uuid; v_lead uuid;
begin
  select org_id, user_id, lead_id into v_org, v_user, v_lead from public.calls where id = p_call;
  if v_org is null or not (public.can_see_user(v_org, v_user) or (v_lead is not null and public.lead_visible(v_lead))) then raise exception 'Not allowed'; end if;
  perform public.write_audit(v_org, 'recording.' || left(p_action, 20), 'call', p_call::text, '{}'::jsonb);
end $$;
