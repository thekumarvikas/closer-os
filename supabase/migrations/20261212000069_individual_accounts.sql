-- Closer OS for individuals (Play Store app): a free one-person account created from the app,
-- account deletion from the app, and phone numbers from any country.

alter table public.organizations add column if not exists is_individual boolean not null default false;

-- Sign-up from the individual app: one-person company, free forever (ads pay for it), no team features.
create or replace function public.create_individual_account(
  p_name text, p_country_code text, p_phone_prefix text, p_currency text, p_timezone text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_name text := nullif(trim(p_name), '');
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  -- Already has a personal account: return it (sign-up retried, app reinstalled…).
  select o.id into v_org from public.organizations o join public.org_members m on m.org_id = o.id
   where o.is_individual and m.user_id = auth.uid() limit 1;
  if v_org is not null then return v_org; end if;

  v_org := public.create_organization(coalesce(v_name, 'My sales'), coalesce(nullif(p_country_code, ''), 'IN'),
    coalesce(nullif(p_phone_prefix, ''), '+91'), coalesce(nullif(p_currency, ''), 'INR'), coalesce(nullif(p_timezone, ''), 'UTC'));
  update public.organizations set is_individual = true,
    settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('show_leaderboard', false, 'call_tracking', 'leads', 'checkin', jsonb_build_object('enabled', false))
   where id = v_org;
  update public.subscriptions set status = 'complimentary', note = 'Individual (free app)' where org_id = v_org;
  if v_name is not null then
    update public.profiles set full_name = v_name where id = auth.uid();
  end if;
  return v_org;
end $$;
revoke all on function public.create_individual_account(text, text, text, text, text) from public, anon;
grant execute on function public.create_individual_account(text, text, text, text, text) to authenticated;

-- "Delete my account" in the individual app (Play Store + App Store rule). Deletes the personal account
-- with all its leads, calls and notes, then the login itself. Members of a company account are told to
-- ask their company admin (their calls belong to the company).
create or replace function public.delete_my_account()
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.org_members m join public.organizations o on o.id = m.org_id
             where m.user_id = v_uid and not o.is_individual) then
    raise exception 'Your login belongs to a company account. Ask your company admin to remove you.';
  end if;
  delete from public.organizations o where o.is_individual
     and exists (select 1 from public.org_members m where m.org_id = o.id and m.user_id = v_uid and m.role = 'owner');
  delete from public.wa_messages where user_id = v_uid;
  update public.organizations set created_by = null where created_by = v_uid;
  delete from auth.users where id = v_uid;
  return 'deleted';
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Phone numbers from any country: a leading 0 (trunk prefix, e.g. UAE 050…, UK 07…, Indonesia 0812…)
-- is replaced by the company's country code; short national numbers get it added.
create or replace function public.normalize_phone(raw text, default_prefix text default '+91')
returns text language plpgsql immutable as $$
declare d text; p text;
begin
  if raw is null then return null; end if;
  d := regexp_replace(raw, '\D', '', 'g');
  p := regexp_replace(coalesce(default_prefix, ''), '\D', '', 'g');
  if d = '' then return null; end if;
  if left(trim(raw), 1) = '+' then return '+' || d; end if;
  if left(d, 2) = '00' then return '+' || substr(d, 3); end if;
  if p <> '' and left(d, 1) = '0' and length(d) between 8 and 13 then return '+' || p || substr(d, 2); end if;
  if p <> '' and length(d) = 10 then return '+' || p || d; end if;
  if p <> '' and left(d, length(p)) = p and length(d) > 10 then return '+' || d; end if;
  if p <> '' and length(d) between 6 and 9 then return '+' || p || d; end if;
  return '+' || d;
end $$;

-- Fix: the content-version trigger read old.org_id on the organizations table (no such column), so every
-- change to company settings / name / time zone failed since migration 0062.
create or replace function public.t_bump_content()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; r jsonb;
begin
  r := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_org := case when tg_table_name = 'organizations' then (r->>'id')::uuid else (r->>'org_id')::uuid end;
  -- The company itself may be on its way out (deleted with everything in it): nothing to bump then.
  if v_org is not null and exists (select 1 from public.organizations where id = v_org) then
    insert into public.org_content_versions (org_id, key) select v_org, tg_argv[0]
    on conflict (org_id, key) do update set v = org_content_versions.v + 1, changed_at = now();
  end if;
  return null;
end $$;
