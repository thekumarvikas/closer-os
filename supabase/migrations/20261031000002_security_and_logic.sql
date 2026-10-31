-- Closer OS: access rules (row level security), triggers and server functions.

-- ───────────────────────── Access helpers ─────────────────────────
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.org_role(p_org uuid)
returns public.member_role language sql stable security definer set search_path = '' as $$
  select role from public.org_members
  where org_id = p_org and user_id = auth.uid() and status = 'active'
$$;

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_super_admin() or public.org_role(p_org) is not null
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_super_admin() or public.org_role(p_org) in ('owner', 'admin')
$$;

-- Users whose data the current user may see inside a company:
-- admins see everyone, managers see their teams, reps see themselves.
create or replace function public.can_see_user(p_org uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    p_user = auth.uid()
    or public.is_org_admin(p_org)
    or (
      public.org_role(p_org) = 'manager' and exists (
        select 1
        from public.team_members mine
        join public.team_members theirs on theirs.team_id = mine.team_id
        where mine.user_id = auth.uid() and mine.is_manager and mine.org_id = p_org
          and theirs.user_id = p_user
      )
    )
$$;

-- Leads: admins see all, managers see their team's (and unassigned), reps see their own.
create or replace function public.can_see_lead(p_org uuid, p_assigned uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_assigned is null then public.is_org_admin(p_org) or public.org_role(p_org) = 'manager'
    else public.can_see_user(p_org, p_assigned)
  end
$$;

create or replace function public.lead_visible(p_lead uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.leads l
    where l.id = p_lead and public.can_see_lead(l.org_id, l.assigned_to)
  )
$$;

create or replace function public.write_audit(p_org uuid, p_action text, p_entity text, p_entity_id text, p_data jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id, data)
  values (p_org, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_data, '{}'))
$$;

-- ───────────────────────── Generic triggers ─────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger t_org_touch before update on public.organizations for each row execute function public.touch_updated_at();
create trigger t_profile_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger t_lead_touch before update on public.leads for each row execute function public.touch_updated_at();
create trigger t_call_touch before update on public.calls for each row execute function public.touch_updated_at();
create trigger t_fu_touch before update on public.follow_ups for each row execute function public.touch_updated_at();

-- New sign-up → profile row.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Nobody can make themselves Super Admin from an app.
create or replace function public.guard_profile()
returns trigger language plpgsql as $$
begin
  if new.is_super_admin is distinct from old.is_super_admin and auth.uid() is not null then
    raise exception 'Not allowed to change super admin flag';
  end if;
  new.email := old.email;
  return new;
end $$;
create trigger t_profile_guard before update on public.profiles for each row execute function public.guard_profile();

-- A company always keeps at least one active owner; only owners manage owners.
create or replace function public.guard_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid := coalesce(new.org_id, old.org_id);
begin
  if auth.uid() is not null and not public.is_super_admin() then
    if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
      if public.org_role(v_org) is distinct from 'owner' then
        raise exception 'Only an owner can add, change or remove owners';
      end if;
    end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' and old.status = 'active' then
    if (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active') and not exists (
      select 1 from public.org_members
      where org_id = v_org and role = 'owner' and status = 'active' and user_id <> old.user_id
    ) then
      raise exception 'A company must keep at least one active owner';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger t_members_guard before insert or update or delete on public.org_members
  for each row execute function public.guard_members();

-- ───────────────────────── Lead triggers ─────────────────────────
create or replace function public.prepare_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_prefix text; v_role public.member_role;
begin
  select phone_prefix into v_prefix from public.organizations where id = new.org_id;
  new.phone := public.normalize_phone(new.phone, v_prefix);
  if new.phone is null or length(new.phone) < 8 then
    raise exception 'Invalid phone number';
  end if;
  new.name := coalesce(trim(new.name), '');
  new.email := nullif(lower(trim(new.email)), '');

  v_role := public.org_role(new.org_id);
  if auth.uid() is not null and not public.is_super_admin() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      -- Reps can only create leads for themselves.
      if v_role = 'rep' then new.assigned_to := auth.uid(); end if;
    else
      if new.org_id <> old.org_id then raise exception 'Cannot move a lead to another company'; end if;
      if v_role = 'rep' and new.assigned_to is distinct from old.assigned_to then
        raise exception 'Only managers and admins can reassign leads';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    new.assigned_at := case when new.assigned_to is null then null else now() end;
  end if;
  return new;
end $$;
create trigger t_lead_prepare before insert or update on public.leads
  for each row execute function public.prepare_lead();

-- Picks a rep for a new unassigned lead using the company's active rules.
create or replace function public.pick_assignee(p_org uuid, p_lead public.leads)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r record; k text; v text; ok boolean; pool uuid[]; chosen uuid;
begin
  for r in
    select * from public.distribution_rules
    where org_id = p_org and is_active and method <> 'manual'
    order by priority, created_at
    for update
  loop
    ok := true;
    if r.method = 'rule' then
      for k, v in select * from jsonb_each_text(r.conditions) loop
        if lower(coalesce(to_jsonb(p_lead)->>k, p_lead.custom->>k, '')) <> lower(v) then ok := false; end if;
      end loop;
    end if;
    continue when not ok;

    -- Only active members of the company can receive leads.
    select array_agg(u order by ord) into pool
    from unnest(r.user_ids) with ordinality as t(u, ord)
    where exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = u and m.status = 'active');
    continue when pool is null or cardinality(pool) = 0;

    chosen := pool[(r.rr_cursor % cardinality(pool)) + 1];
    update public.distribution_rules set rr_cursor = rr_cursor + 1 where id = r.id;
    return chosen;
  end loop;
  return null;
end $$;

create or replace function public.after_lead_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if new.assigned_to is null and coalesce(current_setting('closeros.skip_distribution', true), '') <> 'on' then
    v_user := public.pick_assignee(new.org_id, new);
    if v_user is not null then
      update public.leads set assigned_to = v_user where id = new.id;
    end if;
  end if;
  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (new.org_id, new.id, auth.uid(), 'created', jsonb_build_object('source', new.source, 'assigned_to', coalesce(v_user, new.assigned_to)));
  return new;
end $$;
create trigger t_lead_after_insert after insert on public.leads
  for each row execute function public.after_lead_insert();

create or replace function public.after_lead_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (new.org_id, new.id, auth.uid(), 'assigned', jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
    -- Open follow-ups move with the lead.
    if new.assigned_to is not null then
      update public.follow_ups set assigned_to = new.assigned_to
      where lead_id = new.id and status = 'pending';
    end if;
  end if;
  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
    values (new.org_id, new.id, auth.uid(), 'stage_changed', jsonb_build_object('from', old.stage_id, 'to', new.stage_id));
  end if;
  return new;
end $$;
create trigger t_lead_after_update after update on public.leads
  for each row execute function public.after_lead_update();

-- ───────────────────────── Row level security ─────────────────────────
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.org_members enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.invitations enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.call_outcomes enable row level security;
alter table public.custom_fields enable row level security;
alter table public.leads enable row level security;
alter table public.lead_phones enable row level security;
alter table public.lead_activities enable row level security;
alter table public.calls enable row level security;
alter table public.follow_ups enable row level security;
alter table public.distribution_rules enable row level security;
alter table public.audit_logs enable row level security;

-- Companies (created only through create_organization()).
create policy org_select on public.organizations for select using (public.is_org_member(id));
create policy org_update on public.organizations for update using (public.is_org_admin(id)) with check (public.is_org_admin(id));

-- Profiles: yourself, and people in your companies.
create policy profile_select on public.profiles for select using (
  id = auth.uid() or public.is_super_admin() or exists (
    select 1 from public.org_members a join public.org_members b on a.org_id = b.org_id
    where a.user_id = auth.uid() and a.status = 'active' and b.user_id = profiles.id
  )
);
create policy profile_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- Members, teams, invitations, settings: everyone in the company reads, admins write.
create policy members_select on public.org_members for select using (public.is_org_member(org_id));
create policy members_write on public.org_members for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

create policy teams_select on public.teams for select using (public.is_org_member(org_id));
create policy teams_write on public.teams for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

create policy team_members_select on public.team_members for select using (public.is_org_member(org_id));
create policy team_members_write on public.team_members for all using (public.is_org_admin(org_id)) with check (
  public.is_org_admin(org_id) and exists (select 1 from public.teams t where t.id = team_id and t.org_id = team_members.org_id)
);

create policy invitations_admin on public.invitations for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

create policy stages_select on public.pipeline_stages for select using (public.is_org_member(org_id));
create policy stages_write on public.pipeline_stages for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
create policy outcomes_select on public.call_outcomes for select using (public.is_org_member(org_id));
create policy outcomes_write on public.call_outcomes for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
create policy fields_select on public.custom_fields for select using (public.is_org_member(org_id));
create policy fields_write on public.custom_fields for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- Leads.
create policy leads_select on public.leads for select using (
  public.is_org_member(org_id) and public.can_see_lead(org_id, assigned_to)
);
create policy leads_insert on public.leads for insert with check (public.is_org_member(org_id));
create policy leads_update on public.leads for update
  using (public.is_org_member(org_id) and public.can_see_lead(org_id, assigned_to))
  with check (public.is_org_member(org_id) and (assigned_to is null or public.can_see_user(org_id, assigned_to)));
create policy leads_delete on public.leads for delete using (public.is_org_admin(org_id));

create policy lead_phones_select on public.lead_phones for select using (public.lead_visible(lead_id));
create policy lead_phones_write on public.lead_phones for all using (public.lead_visible(lead_id)) with check (
  public.lead_visible(lead_id) and exists (select 1 from public.leads l where l.id = lead_id and l.org_id = lead_phones.org_id)
);

create policy activities_select on public.lead_activities for select using (public.lead_visible(lead_id));
create policy activities_insert on public.lead_activities for insert with check (
  public.lead_visible(lead_id) and user_id = auth.uid()
  and exists (select 1 from public.leads l where l.id = lead_id and l.org_id = lead_activities.org_id)
);

-- Calls: reps see their own, managers their teams', admins everything.
create policy calls_select on public.calls for select using (
  public.is_org_member(org_id) and public.can_see_user(org_id, user_id)
);
create policy calls_insert on public.calls for insert with check (
  user_id = auth.uid() and public.is_org_member(org_id)
  and (lead_id is null or public.lead_visible(lead_id))
);
create policy calls_update on public.calls for update
  using (user_id = auth.uid() or public.is_org_admin(org_id))
  with check (public.is_org_member(org_id) and (lead_id is null or public.lead_visible(lead_id)));

-- Follow-ups.
create policy follow_ups_select on public.follow_ups for select using (
  public.is_org_member(org_id) and public.can_see_user(org_id, assigned_to)
);
create policy follow_ups_write on public.follow_ups for all
  using (public.is_org_member(org_id) and public.can_see_user(org_id, assigned_to))
  with check (
    public.is_org_member(org_id) and public.can_see_user(org_id, assigned_to)
    and public.lead_visible(lead_id)
    and exists (select 1 from public.leads l where l.id = lead_id and l.org_id = follow_ups.org_id)
  );

create policy rules_admin on public.distribution_rules for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
create policy audit_select on public.audit_logs for select using (org_id is not null and public.is_org_admin(org_id) or public.is_super_admin());

-- ───────────────────────── Server functions used by the apps ─────────────────────────

-- Creates a company with the signed-in user as owner, plus default stages and outcomes.
create or replace function public.create_organization(
  p_name text, p_country_code text default 'IN', p_phone_prefix text default '+91',
  p_currency text default 'INR', p_timezone text default 'Asia/Kolkata'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.organizations (name, country_code, phone_prefix, currency, timezone, created_by)
  values (trim(p_name), upper(p_country_code), p_phone_prefix, upper(p_currency), p_timezone, auth.uid())
  returning id into v_org;

  insert into public.org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');

  insert into public.pipeline_stages (org_id, name, position, is_won, is_lost) values
    (v_org, 'New', 1, false, false),
    (v_org, 'Contacted', 2, false, false),
    (v_org, 'Interested', 3, false, false),
    (v_org, 'Qualified', 4, false, false),
    (v_org, 'Payment Link Shared', 5, false, false),
    (v_org, 'Won', 6, true, false),
    (v_org, 'Lost', 7, false, true);

  insert into public.call_outcomes (org_id, code, label, category, form, position) values
    (v_org, 'no_answer',        'No Answer',                 'not_connected', null,        1),
    (v_org, 'busy',             'Busy',                      'not_connected', null,        2),
    (v_org, 'not_reachable',    'Not Reachable',             'not_connected', null,        3),
    (v_org, 'rejected',         'Call Rejected',             'not_connected', null,        4),
    (v_org, 'not_interested',   'Connected – Not Interested','lost',          null,        5),
    (v_org, 'interested',       'Interested',                'positive',      'interest',  6),
    (v_org, 'follow_up',        'Follow-up Required',        'connected',     null,        7),
    (v_org, 'call_back',        'Call Back Later',           'connected',     null,        8),
    (v_org, 'qualified',        'Qualified',                 'positive',      'interest',  9),
    (v_org, 'payment_link',     'Payment Link Shared',       'positive',      null,        10),
    (v_org, 'sale_closed',      'Sale Closed',               'won',           'sale',      11),
    (v_org, 'sale_lost',        'Sale Lost',                 'lost',          null,        12),
    (v_org, 'wrong_number',     'Wrong Number',              'invalid',       null,        13),
    (v_org, 'do_not_call',      'Do Not Call',               'invalid',       null,        14),
    (v_org, 'other',            'Other',                     'connected',     null,        15);

  perform public.write_audit(v_org, 'organization.created', 'organization', v_org::text, jsonb_build_object('name', p_name));
  return v_org;
end $$;

-- Joins every company that invited the signed-in user's email. Called after login.
create or replace function public.accept_my_invitations()
returns int language plpgsql security definer set search_path = '' as $$
declare v_email text; inv record; n int := 0; t uuid;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  for inv in
    select * from public.invitations
    where lower(email) = v_email and accepted_at is null and expires_at > now()
    for update
  loop
    insert into public.org_members (org_id, user_id, role)
    values (inv.org_id, auth.uid(), inv.role)
    on conflict (org_id, user_id) do update set status = 'active', role = excluded.role;
    foreach t in array inv.team_ids loop
      insert into public.team_members (team_id, user_id, org_id, is_manager)
      select t, auth.uid(), inv.org_id, inv.role = 'manager'
      where exists (select 1 from public.teams where id = t and org_id = inv.org_id)
      on conflict do nothing;
    end loop;
    update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
    insert into public.audit_logs (org_id, actor_id, action, entity, entity_id)
    values (inv.org_id, auth.uid(), 'invitation.accepted', 'invitation', inv.id::text);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Bulk import. Normalises numbers, skips duplicates (in the file and in the database),
-- and assigns by: 'rules' (distribution rules), 'user' (one person) or 'none'.
-- p_rows: [{"name":..,"phone":..,"email":..,"city":..,"source":..,"custom":{..}}, …]
create or replace function public.import_leads(
  p_org uuid, p_rows jsonb, p_source text default null, p_campaign text default null,
  p_assign_mode text default 'rules', p_assign_to uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text; r jsonb; v_phone text; v_ins int := 0; v_dup int := 0; v_bad int := 0;
  v_seen text[] := '{}'; v_assignee uuid; v_lead public.leads;
  std text[] := array['name','phone','email','country','state','city','timezone','profession','company','source','campaign','notes','deal_value','tags'];
begin
  if not (public.is_org_admin(p_org) or public.org_role(p_org) = 'manager') then
    raise exception 'Only admins and managers can import leads';
  end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  if p_assign_mode = 'user' and (p_assign_to is null or not public.can_see_user(p_org, p_assign_to)) then
    raise exception 'Choose someone you manage to assign these leads to';
  end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  if p_assign_mode <> 'rules' then perform set_config('closeros.skip_distribution', 'on', true); end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_phone(r->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then v_bad := v_bad + 1; continue; end if;
    if v_phone = any(v_seen)
       or exists (select 1 from public.leads where org_id = p_org and phone = v_phone and deleted_at is null)
       or exists (select 1 from public.lead_phones where org_id = p_org and phone = v_phone) then
      v_dup := v_dup + 1; continue;
    end if;
    v_seen := v_seen || v_phone;

    v_assignee := case p_assign_mode when 'user' then p_assign_to else null end;
    insert into public.leads (org_id, name, phone, email, country, state, city, timezone, profession, company,
                              source, campaign, notes, deal_value, tags, custom, assigned_to, currency)
    values (
      p_org, coalesce(r->>'name', ''), v_phone, r->>'email', r->>'country', r->>'state', r->>'city', r->>'timezone',
      r->>'profession', r->>'company', coalesce(nullif(r->>'source', ''), p_source), coalesce(nullif(r->>'campaign', ''), p_campaign),
      r->>'notes', nullif(regexp_replace(coalesce(r->>'deal_value', ''), '[^0-9.]', '', 'g'), '')::numeric,
      coalesce(array(select trim(x) from unnest(string_to_array(r->>'tags', ',')) x where trim(x) <> ''), '{}'),
      coalesce(r->'custom', '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(r) as e(k, v) where k <> 'custom' and not k = any(std)), '{}'::jsonb),
      v_assignee, null
    );
    v_ins := v_ins + 1;
  end loop;

  perform set_config('closeros.skip_distribution', 'off', true);
  perform public.write_audit(p_org, 'leads.imported', 'lead', null,
    jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'invalid', v_bad, 'source', p_source));
  return jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'invalid', v_bad);
end $$;

-- Assigns leads to one person, or spreads them evenly across several (round-robin).
create or replace function public.assign_leads(p_org uuid, p_lead_ids uuid[], p_user_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare i int := 0; l uuid; n int; u uuid;
begin
  if not (public.is_org_admin(p_org) or public.org_role(p_org) = 'manager') then
    raise exception 'Only admins and managers can assign leads';
  end if;
  n := coalesce(cardinality(p_user_ids), 0);
  if n = 0 then raise exception 'Choose at least one person'; end if;
  foreach u in array p_user_ids loop
    if not exists (select 1 from public.org_members where org_id = p_org and user_id = u and status = 'active')
       or not public.can_see_user(p_org, u) then
      raise exception 'You cannot assign leads to that person';
    end if;
  end loop;
  foreach l in array p_lead_ids loop
    update public.leads set assigned_to = p_user_ids[(i % n) + 1]
    where id = l and org_id = p_org and public.can_see_lead(org_id, assigned_to);
    if found then i := i + 1; end if;
  end loop;
  perform public.write_audit(p_org, 'leads.assigned', 'lead', null, jsonb_build_object('count', i, 'users', p_user_ids));
  return i;
end $$;

-- Saves one call with its outcome in a single step (used by the app, also offline-retry safe).
-- Requires either a next follow-up time or p_no_follow_up = true.
create or replace function public.log_call(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_id uuid := (p->>'id')::uuid;
  v_lead uuid := nullif(p->>'lead_id', '')::uuid;
  v_outcome uuid := nullif(p->>'outcome_id', '')::uuid;
  v_follow timestamptz := nullif(p->>'follow_up_at', '')::timestamptz;
  v_no_follow boolean := coalesce((p->>'no_follow_up')::boolean, false);
  v_stage uuid := nullif(p->>'stage_id', '')::uuid;
  v_prefix text; v_cat public.outcome_category; v_code text; v_fu uuid;
begin
  if not public.is_org_member(v_org) then raise exception 'Not a member of this company'; end if;
  if v_lead is not null and not public.lead_visible(v_lead) then raise exception 'Lead not found'; end if;
  if v_outcome is not null then
    select category, code into v_cat, v_code from public.call_outcomes where id = v_outcome and org_id = v_org;
    if v_cat is null then raise exception 'Unknown outcome'; end if;
    if v_follow is null and not v_no_follow then
      raise exception 'Choose the next call time or "No follow-up needed"';
    end if;
  end if;
  select phone_prefix into v_prefix from public.organizations where id = v_org;

  insert into public.calls (id, org_id, lead_id, user_id, device_id, direction, phone, started_at, ended_at,
                            duration_sec, sim_slot, sim_label, outcome_id, outcome_data, notes, from_dialer_queue, recording_status)
  values (
    v_id, v_org, v_lead, auth.uid(), p->>'device_id', (p->>'direction')::public.call_direction,
    public.normalize_phone(p->>'phone', v_prefix), (p->>'started_at')::timestamptz, nullif(p->>'ended_at', '')::timestamptz,
    coalesce((p->>'duration_sec')::int, 0), nullif(p->>'sim_slot', '')::int, p->>'sim_label', v_outcome,
    coalesce(p->'outcome_data', '{}'::jsonb), p->>'notes', coalesce((p->>'from_dialer_queue')::boolean, false),
    coalesce(nullif(p->>'recording_status', ''), 'not_expected')::public.recording_status
  )
  on conflict (id) do update set
    outcome_id = coalesce(excluded.outcome_id, public.calls.outcome_id),
    outcome_data = case when excluded.outcome_id is not null then excluded.outcome_data else public.calls.outcome_data end,
    notes = coalesce(excluded.notes, public.calls.notes),
    lead_id = coalesce(public.calls.lead_id, excluded.lead_id),
    ended_at = coalesce(excluded.ended_at, public.calls.ended_at),
    duration_sec = greatest(excluded.duration_sec, public.calls.duration_sec),
    recording_status = excluded.recording_status
  where public.calls.user_id = auth.uid();

  if v_lead is not null then
    update public.leads set
      last_call_at = greatest(coalesce(last_call_at, '-infinity'), (p->>'started_at')::timestamptz),
      last_outcome_id = coalesce(v_outcome, last_outcome_id),
      stage_id = coalesce(v_stage, stage_id),
      do_not_call = do_not_call or v_code = 'do_not_call',
      deal_value = coalesce(nullif(p->'outcome_data'->>'deal_value', '')::numeric, nullif(p->'outcome_data'->>'amount', '')::numeric, deal_value),
      notes = case when nullif(p->>'notes', '') is null then notes
                   else concat_ws(E'\n', notes, to_char(now() at time zone 'Asia/Kolkata', 'DD/MM HH24:MI') || ': ' || (p->>'notes')) end
    where id = v_lead;

    if v_outcome is not null then
      -- The previous open follow-up is done once the lead has been called again.
      update public.follow_ups set status = 'done', completed_at = now()
      where lead_id = v_lead and status = 'pending' and due_at <= now() + interval '1 day';

      if v_follow is not null then
        insert into public.follow_ups (org_id, lead_id, assigned_to, due_at, reason, notes, call_id, created_by, priority)
        values (v_org, v_lead, coalesce((select assigned_to from public.leads where id = v_lead), auth.uid()), v_follow,
                p->>'follow_up_reason', p->>'follow_up_notes', v_id, auth.uid(), coalesce((p->>'follow_up_priority')::smallint, 2))
        returning id into v_fu;
      end if;
      update public.leads set next_follow_up_at = (
        select min(due_at) from public.follow_ups where lead_id = v_lead and status = 'pending'
      ) where id = v_lead;

      insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
      values (v_org, v_lead, auth.uid(), 'call', jsonb_build_object(
        'call_id', v_id, 'direction', p->>'direction', 'duration_sec', p->>'duration_sec',
        'outcome', v_code, 'follow_up_at', v_follow, 'no_follow_up', v_no_follow));
    end if;
  end if;
  return jsonb_build_object('call_id', v_id, 'follow_up_id', v_fu);
end $$;

-- Lock down: anonymous visitors get nothing; signed-in users go through the rules above.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.pick_assignee(uuid, public.leads) from authenticated;
revoke execute on function public.write_audit(uuid, text, text, text, jsonb) from authenticated;
grant execute on function public.normalize_phone(text, text) to anon;
