-- Super Admin: add a company by hand (owner's Gmail, contact, start + end date, "sales through webinars / sales events /
-- workshops" switch) and a health card per company. Owner (Nov 17 2026): no word "pilot"; sign-in with Google only.
-- The owner joins through the existing invitation (accept_my_invitations runs at every sign-in on the website and app):
-- the company is created with an owner invitation for that email; signing in with that Google account makes them owner.

alter table public.organizations add column if not exists contact_name text;
alter table public.organizations add column if not exists contact_email text;
alter table public.organizations add column if not exists contact_phone text;
alter table public.organizations add column if not exists added_by_admin boolean not null default false;
alter table public.subscriptions add column if not exists starts_at timestamptz;

-- Stages + outcomes every new company gets (was inside create_organization).
create or replace function public.org_seed_basics(p_org uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pipeline_stages (org_id, name, position, is_won, is_lost) values
    (p_org, 'New', 1, false, false), (p_org, 'Contacted', 2, false, false), (p_org, 'Interested', 3, false, false),
    (p_org, 'Qualified', 4, false, false), (p_org, 'Payment Link Shared', 5, false, false), (p_org, 'Won', 6, true, false),
    (p_org, 'Lost', 7, false, true);
  insert into public.call_outcomes (org_id, code, label, category, form, position) values
    (p_org, 'no_answer', 'No Answer', 'not_connected', null, 1),
    (p_org, 'busy', 'Busy', 'not_connected', null, 2),
    (p_org, 'not_reachable', 'Not Reachable', 'not_connected', null, 3),
    (p_org, 'rejected', 'Call Rejected', 'not_connected', null, 4),
    (p_org, 'not_interested', 'Connected – Not Interested', 'lost', null, 5),
    (p_org, 'interested', 'Interested', 'positive', 'interest', 6),
    (p_org, 'follow_up', 'Follow-up Required', 'connected', null, 7),
    (p_org, 'call_back', 'Call Back Later', 'connected', null, 8),
    (p_org, 'qualified', 'Qualified', 'positive', 'interest', 9),
    (p_org, 'payment_link', 'Payment Link Shared', 'positive', null, 10),
    (p_org, 'sale_closed', 'Sale Closed', 'won', 'sale', 11),
    (p_org, 'sale_lost', 'Sale Lost', 'lost', null, 12),
    (p_org, 'wrong_number', 'Wrong Number', 'invalid', null, 13),
    (p_org, 'do_not_call', 'Do Not Call', 'invalid', null, 14),
    (p_org, 'other', 'Other', 'connected', null, 15);
  perform public.apply_outcome_set_v2(p_org);
end $$;
revoke execute on function public.org_seed_basics(uuid) from anon, public, authenticated;

-- Website sign-up "A company with a sales team" — now with the webinars switch (settings.sells_via_events).
drop function if exists public.create_organization(text, text, text, text, text);
create or replace function public.create_organization(
  p_name text, p_country_code text default 'IN', p_phone_prefix text default '+91',
  p_currency text default 'INR', p_timezone text default 'Asia/Kolkata', p_sells_events boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.organizations (name, country_code, phone_prefix, currency, timezone, created_by, contact_email)
  values (trim(p_name), upper(p_country_code), p_phone_prefix, upper(p_currency), p_timezone, auth.uid(),
          (select email from auth.users where id = auth.uid()))
  returning id into v_org;
  update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('sells_via_events', coalesce(p_sells_events, true)) where id = v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  perform public.org_seed_basics(v_org);
  perform public.write_audit(v_org, 'organization.created', 'organization', v_org::text, jsonb_build_object('name', p_name));
  return v_org;
end $$;
revoke execute on function public.create_organization(text, text, text, text, text, boolean) from anon, public;
grant execute on function public.create_organization(text, text, text, text, text, boolean) to authenticated;

-- Super Admin adds a company. p: {name, owner_name, email, phone, country_code, phone_prefix, currency, timezone,
-- starts_at, ends_at, sells_events, note}. Access runs until ends_at (shown as a free trial to the company; after it the
-- usual grace days, then the plan page). The owner joins by signing in with Google using that email.
create or replace function public.sa_create_company(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_email text := lower(trim(coalesce(p->>'email', ''))); v_end timestamptz := nullif(p->>'ends_at', '')::timestamptz;
  v_start timestamptz := coalesce(nullif(p->>'starts_at', '')::timestamptz, now()); v_user uuid;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  if length(trim(coalesce(p->>'name', ''))) < 2 then raise exception 'Type the company name'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Type the owner''s email (the Google account they will sign in with)'; end if;
  if v_end is null or v_end <= v_start then raise exception 'Choose an end date after the start date'; end if;
  insert into public.organizations (name, country_code, phone_prefix, currency, timezone, created_by, contact_name, contact_email, contact_phone, added_by_admin)
  values (trim(p->>'name'), upper(coalesce(nullif(p->>'country_code', ''), 'IN')), coalesce(nullif(p->>'phone_prefix', ''), '+91'),
          upper(coalesce(nullif(p->>'currency', ''), 'INR')), coalesce(nullif(p->>'timezone', ''), 'Asia/Kolkata'), auth.uid(),
          nullif(trim(p->>'owner_name'), ''), v_email, nullif(trim(p->>'phone'), ''), true)
  returning id into v_org;
  update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('sells_via_events', coalesce((p->>'sells_events')::boolean, true)) where id = v_org;
  perform public.org_seed_basics(v_org);
  update public.subscriptions set status = 'trialing', starts_at = v_start, trial_ends_at = v_end,
    note = nullif(trim(p->>'note'), ''), updated_at = now() where org_id = v_org;
  insert into public.invitations (org_id, email, role, invited_by, expires_at)
  values (v_org, v_email, 'owner', auth.uid(), greatest(v_end, now() + interval '30 days'));
  -- Already has a Closer OS login with that email (e.g. signed in before): make them owner now.
  select id into v_user from auth.users where lower(email) = v_email and email_confirmed_at is not null;
  if v_user is not null then
    insert into public.org_members (org_id, user_id, role) values (v_org, v_user, 'owner') on conflict (org_id, user_id) do update set role = 'owner', status = 'active';
    update public.invitations set accepted_at = now(), accepted_by = v_user where org_id = v_org and lower(email) = v_email;
  end if;
  perform public.write_audit(v_org, 'organization.added_by_admin', 'organization', v_org::text, p - 'note');
  return jsonb_build_object('org_id', v_org, 'joined', v_user is not null);
end $$;
revoke execute on function public.sa_create_company(jsonb) from anon, public;
grant execute on function public.sa_create_company(jsonb) to authenticated;

-- Super Admin edits a company's details: name, contact, webinars switch, start date, owner email (while not joined yet).
create or replace function public.sa_update_company(p_org uuid, p jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p->>'email', '')));
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  update public.organizations set
    name = coalesce(nullif(trim(p->>'name'), ''), name),
    contact_name = case when p ? 'owner_name' then nullif(trim(p->>'owner_name'), '') else contact_name end,
    contact_phone = case when p ? 'phone' then nullif(trim(p->>'phone'), '') else contact_phone end,
    contact_email = case when v_email <> '' then v_email else contact_email end,
    settings = case when p ? 'sells_events' then coalesce(settings, '{}'::jsonb) || jsonb_build_object('sells_via_events', (p->>'sells_events')::boolean) else settings end
  where id = p_org;
  if p ? 'starts_at' then update public.subscriptions set starts_at = nullif(p->>'starts_at', '')::timestamptz where org_id = p_org; end if;
  -- New owner email while nobody has joined as owner yet: replace the open owner invitation.
  if v_email <> '' and not exists (select 1 from public.org_members where org_id = p_org and role = 'owner' and status = 'active') then
    update public.invitations set expires_at = now() where org_id = p_org and role = 'owner' and accepted_at is null and lower(email) <> v_email;
    if not exists (select 1 from public.invitations where org_id = p_org and role = 'owner' and accepted_at is null and lower(email) = v_email and expires_at > now()) then
      insert into public.invitations (org_id, email, role, invited_by, expires_at) values (p_org, v_email, 'owner', auth.uid(), now() + interval '60 days');
    end if;
  end if;
  perform public.write_audit(p_org, 'organization.updated_by_admin', 'organization', p_org::text, p);
end $$;
revoke execute on function public.sa_update_company(uuid, jsonb) from anon, public;
grant execute on function public.sa_update_company(uuid, jsonb) to authenticated;

-- Company list: adds contact, start date, webinars switch, owner joined or still invited.
create or replace function public.sa_companies()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object('id', o.id, 'name', o.name, 'created_at', o.created_at, 'is_individual', o.is_individual,
      'owner', (select p.email from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = o.id and m.role = 'owner' and m.status = 'active' limit 1),
      'invited_owner', (select i.email from public.invitations i where i.org_id = o.id and i.role = 'owner' and i.accepted_at is null and i.expires_at > now() order by i.created_at desc limit 1),
      'contact_name', o.contact_name, 'contact_email', o.contact_email, 'contact_phone', o.contact_phone, 'added_by_admin', o.added_by_admin,
      'sells_events', coalesce((o.settings->>'sells_via_events')::boolean, true),
      'users', (select count(*) from public.org_members m where m.org_id = o.id and m.status = 'active'),
      'calls_7d', (select count(*) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days'),
      'last_call', (select max(started_at) from public.calls c where c.org_id = o.id),
      'status', s.status, 'plan', pl.name, 'plan_id', s.plan_id, 'seats', s.seats, 'cycle', s.cycle, 'starts_at', s.starts_at,
      'trial_ends_at', s.trial_ends_at, 'current_period_end', s.current_period_end, 'note', s.note,
      'paid_total', (select coalesce(sum(amount), 0) from public.payments py where py.org_id = o.id and py.status = 'paid')) as x
    from public.organizations o left join public.subscriptions s on s.org_id = o.id left join public.plans pl on pl.id = s.plan_id) t;
  return res;
end $$;

-- Health card: one row per company (individual accounts left out unless p_individual).
create or replace function public.sa_company_health(p_individual boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(x order by (x->>'last_activity') desc nulls last), '[]'::jsonb) into res from (
    select jsonb_build_object('id', o.id, 'name', o.name, 'created_at', o.created_at,
      'contact_name', o.contact_name, 'contact_email', o.contact_email, 'contact_phone', o.contact_phone,
      'status', s.status, 'starts_at', coalesce(s.starts_at, o.created_at),
      'ends_at', case s.status when 'trialing' then s.trial_ends_at when 'active' then s.current_period_end end,
      'owner_joined', exists (select 1 from public.org_members m where m.org_id = o.id and m.role = 'owner' and m.status = 'active'),
      'invited_owner', (select i.email from public.invitations i where i.org_id = o.id and i.role = 'owner' and i.accepted_at is null and i.expires_at > now() order by i.created_at desc limit 1),
      'members', (select count(*) from public.org_members m where m.org_id = o.id and m.status = 'active'),
      'reps', (select count(*) from public.org_members m where m.org_id = o.id and m.status = 'active' and m.role = 'rep'),
      'invites_open', (select count(*) from public.invitations i where i.org_id = o.id and i.accepted_at is null and i.expires_at > now()),
      'phones', (select count(distinct d.user_id) from public.device_status d where d.org_id = o.id),
      'phones_synced_24h', (select count(distinct d.user_id) from public.device_status d where d.org_id = o.id and d.updated_at > now() - interval '24 hours'),
      'phones_setup_missing', (select count(distinct d.user_id) from public.device_status d where d.org_id = o.id and d.updated_at > now() - interval '7 days'
         and exists (select 1 from jsonb_each(coalesce(d.setup, '{}'::jsonb)) e where e.key in ('calls', 'battery', 'autostart', 'overlay', 'notify') and e.value = 'false'::jsonb)),
      'rec_folder_missing', (select count(distinct d.user_id) from public.device_status d where d.org_id = o.id and d.updated_at > now() - interval '7 days' and not coalesce(d.rec_folder_set, false)),
      'leads', (select count(*) from public.leads l where l.org_id = o.id and l.deleted_at is null),
      'leads_7d', (select count(*) from public.leads l where l.org_id = o.id and l.deleted_at is null and l.created_at > now() - interval '7 days'),
      'calls_today', (select count(*) from public.calls c where c.org_id = o.id and c.started_at >= date_trunc('day', now() at time zone o.timezone) at time zone o.timezone),
      'calls_7d', (select count(*) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days'),
      'callers_7d', (select count(distinct c.user_id) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days'),
      'outcomes_7d', (select count(*) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days' and c.outcome_id is not null),
      'rec_uploaded_7d', (select count(*) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days' and c.recording_status = 'uploaded'),
      'rec_missing_7d', (select count(*) from public.calls c where c.org_id = o.id and c.started_at > now() - interval '7 days' and c.recording_status = 'missing'),
      'last_call', (select max(c.started_at) from public.calls c where c.org_id = o.id),
      'last_activity', greatest((select max(c.started_at) from public.calls c where c.org_id = o.id),
                                (select max(d.updated_at) from public.device_status d where d.org_id = o.id),
                                (select max(l.created_at) from public.leads l where l.org_id = o.id), o.created_at)) as x
    from public.organizations o left join public.subscriptions s on s.org_id = o.id
    where p_individual or not o.is_individual) t;
  return res;
end $$;
revoke execute on function public.sa_company_health(boolean) from anon, public;
grant execute on function public.sa_company_health(boolean) to authenticated;

-- Owner invitations (Super Admin "Add a company", or an owner inviting another owner) could never be accepted: the
-- member guard refused anyone becoming owner unless they already were one. Now accepting an open owner invitation for
-- your own email is allowed.
create or replace function public.guard_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid := coalesce(new.org_id, old.org_id);
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = v_org) then
    return old;
  end if;
  if auth.uid() is not null and not public.is_super_admin() then
    if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
      if public.org_role(v_org) is distinct from 'owner'
         and not (tg_op = 'INSERT' and new.user_id = auth.uid()
                  and not exists (select 1 from public.org_members where org_id = v_org)
                  and exists (select 1 from public.organizations where id = v_org and created_by = auth.uid()))
         and not (tg_op <> 'DELETE' and new.user_id = auth.uid() and new.role = 'owner'
                  and exists (select 1 from public.invitations i join auth.users u on lower(u.email) = lower(i.email)
                              where i.org_id = v_org and i.role = 'owner' and i.accepted_at is null and i.expires_at > now()
                                and u.id = auth.uid() and u.email_confirmed_at is not null
                                and (exists (select 1 from public.profiles sp where sp.id = i.invited_by and sp.is_super_admin)
                                     or exists (select 1 from public.org_members om where om.org_id = v_org and om.user_id = i.invited_by
                                                and om.role = 'owner' and om.status = 'active')))) then
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
