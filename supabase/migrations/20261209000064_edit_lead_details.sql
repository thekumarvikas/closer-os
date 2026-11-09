-- Reps edit a lead's details from the app (name, number, email, company, profession, city, state,
-- profession group, company's own fields). Only these fields; logged on the lead's timeline.
create or replace function public.update_lead_details(p_lead uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.leads; v_prefix text; v_phone text; v_dup text; v_changed text[] := '{}';
begin
  select * into l from public.leads where id = p_lead and deleted_at is null;
  if l.id is null then raise exception 'Lead not found'; end if;
  if not (public.is_org_member(l.org_id) and public.lead_visible(l.id)) then raise exception 'Not allowed'; end if;

  if p ? 'phone' then
    select phone_prefix into v_prefix from public.organizations where id = l.org_id;
    v_phone := public.normalize_phone(p->>'phone', v_prefix);
    if v_phone is null or length(v_phone) < 8 then raise exception 'Enter a valid phone number'; end if;
    if v_phone <> l.phone then
      select coalesce(nullif(name, ''), phone) into v_dup from public.leads
        where org_id = l.org_id and phone = v_phone and deleted_at is null and id <> l.id limit 1;
      if v_dup is not null then raise exception 'Another lead already has this number: %', v_dup; end if;
      v_changed := array_append(v_changed, 'phone');
    end if;
  end if;

  if p ? 'name' and coalesce(nullif(trim(p->>'name'), ''), '') = '' then raise exception 'Name can''t be empty'; end if;
  if p ? 'name' and trim(p->>'name') is distinct from l.name then v_changed := array_append(v_changed, 'name'); end if;
  if p ? 'email' and nullif(trim(p->>'email'), '') is distinct from l.email then v_changed := array_append(v_changed, 'email'); end if;
  if p ? 'company' and nullif(trim(p->>'company'), '') is distinct from l.company then v_changed := array_append(v_changed, 'company'); end if;
  if p ? 'profession' and nullif(trim(p->>'profession'), '') is distinct from l.profession then v_changed := array_append(v_changed, 'profession'); end if;
  if p ? 'city' and nullif(trim(p->>'city'), '') is distinct from l.city then v_changed := array_append(v_changed, 'city'); end if;
  if p ? 'state' and nullif(trim(p->>'state'), '') is distinct from l.state then v_changed := array_append(v_changed, 'state'); end if;
  if p ? 'profession_category_id' and nullif(p->>'profession_category_id', '')::uuid is distinct from l.profession_category_id then v_changed := array_append(v_changed, 'profession group'); end if;
  if p ? 'custom' and jsonb_typeof(p->'custom') = 'object' and (coalesce(l.custom, '{}') || (p->'custom')) is distinct from coalesce(l.custom, '{}') then v_changed := array_append(v_changed, 'other details'); end if;
  if cardinality(v_changed) = 0 then return jsonb_build_object('changed', '[]'::jsonb); end if;

  update public.leads set
    name = case when p ? 'name' then trim(p->>'name') else name end,
    phone = coalesce(v_phone, phone),
    email = case when p ? 'email' then nullif(trim(p->>'email'), '') else email end,
    company = case when p ? 'company' then nullif(trim(p->>'company'), '') else company end,
    profession = case when p ? 'profession' then nullif(trim(p->>'profession'), '') else profession end,
    city = case when p ? 'city' then nullif(trim(p->>'city'), '') else city end,
    state = case when p ? 'state' then nullif(trim(p->>'state'), '') else state end,
    profession_category_id = case when p ? 'profession_category_id' then nullif(p->>'profession_category_id', '')::uuid else profession_category_id end,
    custom = case when p ? 'custom' and jsonb_typeof(p->'custom') = 'object'
                  then jsonb_strip_nulls(coalesce(custom, '{}') || (p->'custom')) else custom end,
    updated_at = now()
  where id = l.id;

  -- A new number: earlier calls with that number (not linked to any lead yet) join this lead.
  if v_phone is not null and v_phone <> l.phone then
    update public.calls set lead_id = l.id where org_id = l.org_id and phone = v_phone and lead_id is null;
  end if;

  insert into public.lead_activities (org_id, lead_id, user_id, kind, data)
  values (l.org_id, l.id, auth.uid(), 'edited', jsonb_build_object('fields', to_jsonb(v_changed),
          'old_phone', case when 'phone' = any(v_changed) then l.phone end));
  return jsonb_build_object('changed', to_jsonb(v_changed), 'phone', coalesce(v_phone, l.phone));
end $$;
revoke all on function public.update_lead_details(uuid, jsonb) from public, anon;
grant execute on function public.update_lead_details(uuid, jsonb) to authenticated;
