-- Automatic lead capture: webhook, Zapier, Pabbly, Flexifunnels, Google Ads / YouTube lead forms,
-- Google Sheets, Facebook (via Zapier/Pabbly now; direct connect later).
--
-- Each lead source has a secret token that is part of its URL:
--   https://<project>.supabase.co/functions/v1/lead-webhook/<token>
-- The edge function passes whatever it receives to ingest_lead(), which understands plain JSON,
-- form posts, Google Ads lead-form payloads and Facebook-style field_data, maps the fields,
-- creates (or re-uses) the lead, adds it to the source's webinar batch, and assigns it.

create table if not exists public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  kind text not null default 'webhook'
    check (kind in ('webhook', 'zapier', 'pabbly', 'flexifunnels', 'google_ads', 'google_sheets', 'facebook')),
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  source_label text,                       -- value written into lead.source, e.g. "Facebook Ads"
  campaign text,                           -- default campaign if the payload has none
  batch_id uuid references public.batches(id) on delete set null,
  assign_mode text not null default 'rules' check (assign_mode in ('rules', 'user', 'none')),
  assign_to uuid references auth.users(id) on delete set null,
  field_map jsonb not null default '{}'::jsonb,   -- {"phone": "mobile_no", "name": "full_name", ...}
  google_key text,                          -- Google Ads lead-form webhook key (checked if set)
  is_active boolean not null default true,
  received_count int not null default 0,
  last_received_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists lead_sources_org_idx on public.lead_sources (org_id);

create table if not exists public.lead_source_events (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.lead_sources(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  status text not null,                     -- created | joined | duplicate | test | error
  lead_id uuid references public.leads(id) on delete set null,
  error text
);
create index if not exists lead_source_events_src_idx on public.lead_source_events (source_id, received_at desc);

alter table public.lead_sources enable row level security;
alter table public.lead_source_events enable row level security;
drop policy if exists lead_sources_manage on public.lead_sources;
create policy lead_sources_manage on public.lead_sources for all using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));
drop policy if exists lead_source_events_read on public.lead_source_events;
create policy lead_source_events_read on public.lead_source_events for select using (public.is_org_manager(org_id));

create or replace function public.lead_key(k text)
returns text language sql immutable set search_path = '' as $$
  select trim(both '_' from regexp_replace(lower(coalesce(k, '')), '[^a-z0-9.]+', '_', 'g'))
$$;

-- Turns any payload into flat lower-case "key → text" pairs.
-- Understands: nested objects (a.b), Google Ads user_column_data, Facebook field_data, arrays of {name,value}.
create or replace function public.flatten_lead_payload(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare out jsonb := '{}'::jsonb; k text; v jsonb; e jsonb; key text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return out; end if;
  for k, v in select * from jsonb_each(p) loop
    if k = 'user_column_data' and jsonb_typeof(v) = 'array' then           -- Google Ads lead form
      for e in select * from jsonb_array_elements(v) loop
        key := lower(coalesce(e->>'column_id', e->>'column_name', ''));
        if key <> '' then out := out || jsonb_build_object(key, coalesce(e->>'string_value', e->>'value', '')); end if;
        if e ? 'column_name' then out := out || jsonb_build_object(lower(e->>'column_name'), coalesce(e->>'string_value', '')); end if;
      end loop;
    elsif k = 'field_data' and jsonb_typeof(v) = 'array' then               -- Facebook lead
      for e in select * from jsonb_array_elements(v) loop
        out := out || jsonb_build_object(lower(e->>'name'), coalesce(e->'values'->>0, e->>'value', ''));
      end loop;
    elsif jsonb_typeof(v) = 'object' then
      out := out || (select coalesce(jsonb_object_agg(lower(k) || '.' || fk, fv), '{}'::jsonb)
                     from jsonb_each(public.flatten_lead_payload(v)) as f(fk, fv));
      out := out || public.flatten_lead_payload(v);   -- also without prefix, for convenience
    elsif jsonb_typeof(v) = 'array' then
      if jsonb_array_length(v) > 0 and jsonb_typeof(v->0) = 'object' and (v->0 ? 'name') then
        for e in select * from jsonb_array_elements(v) loop
          out := out || jsonb_build_object(lower(e->>'name'), coalesce(e->>'value', e->'values'->>0, ''));
        end loop;
      else
        out := out || jsonb_build_object(lower(k), (select string_agg(x, ', ') from jsonb_array_elements_text(v) x));
      end if;
    elsif jsonb_typeof(v) <> 'null' then
      out := out || jsonb_build_object(lower(k), v #>> '{}');
    end if;
  end loop;
  -- Same spelling for every key: "Mobile No" → "mobile_no".
  return (select coalesce(jsonb_object_agg(public.lead_key(x.kk), x.vv), '{}'::jsonb) from jsonb_each(out) as x(kk, vv));
end $$;

-- Picks a field: first the manager's mapping, then common names used by forms and tools.
create or replace function public.pick_lead_field(f jsonb, map jsonb, target text, guesses text[])
returns text language sql immutable set search_path = '' as $$
  select nullif(trim(coalesce(
    case when map ? target then f->>public.lead_key(map->>target) end,
    (select f->>g from unnest(guesses) g where nullif(trim(f->>g), '') is not null limit 1)
  )), '')
$$;

create or replace function public.ingest_lead(p_token text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.lead_sources; f jsonb; m jsonb; v_prefix text;
  v_name text; v_phone text; v_email text; v_first text; v_last text; v_status text; v_lead uuid; v_minutes int;
  std text[] := array['name','full_name','fullname','first_name','last_name','phone','phone_number','mobile','email'];
  v_custom jsonb;
begin
  select * into s from public.lead_sources where token = p_token;
  if s.id is null or not s.is_active then
    return jsonb_build_object('ok', false, 'error', 'Unknown or paused lead source');
  end if;
  -- Google Ads sends its webhook key with every lead; reject if it doesn't match.
  if s.google_key is not null and s.google_key <> '' and p_payload ? 'google_key' and p_payload->>'google_key' <> s.google_key then
    return jsonb_build_object('ok', false, 'error', 'Wrong Google key');
  end if;

  f := public.flatten_lead_payload(p_payload);
  m := s.field_map;
  select phone_prefix into v_prefix from public.organizations where id = s.org_id;

  v_first := public.pick_lead_field(f, m, 'first_name', array['first_name', 'firstname', 'fname', 'given_name']);
  v_last := public.pick_lead_field(f, m, 'last_name', array['last_name', 'lastname', 'lname', 'family_name', 'surname']);
  v_name := coalesce(public.pick_lead_field(f, m, 'name', array['full_name', 'fullname', 'name', 'your_name', 'customer_name', 'contact_name', 'lead_name', 'sender_name']),
                     nullif(trim(concat_ws(' ', v_first, v_last)), ''), '');
  v_phone := public.normalize_phone(public.pick_lead_field(f, m, 'phone', array['phone_number', 'phone', 'mobile', 'mobile_number', 'mobile_no', 'contact', 'contact_number',
               'whatsapp', 'whatsapp_number', 'phone_no', 'cell', 'telephone', 'number', 'sender_mobile', 'user_phone']), v_prefix);
  v_email := lower(public.pick_lead_field(f, m, 'email', array['email', 'email_address', 'e_mail', 'mail', 'your_email', 'sender_email', 'user_email']));

  if coalesce((p_payload->>'is_test')::boolean, false) then
    insert into public.lead_source_events (source_id, org_id, payload, status) values (s.id, s.org_id, p_payload, 'test');
    update public.lead_sources set last_received_at = now() where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'test');
  end if;

  if v_phone is null or length(v_phone) < 8 then
    insert into public.lead_source_events (source_id, org_id, payload, status, error)
    values (s.id, s.org_id, p_payload, 'error', 'No valid phone number found');
    update public.lead_sources set last_received_at = now(), received_count = received_count + 1 where id = s.id;
    return jsonb_build_object('ok', false, 'error', 'No valid phone number found');
  end if;

  -- Everything we didn't map is kept as custom fields (e.g. "what is your profession").
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_custom
  from jsonb_each_text(f) as e(k, v)
  where not k = any(std) and v <> '' and k not like '%.%' and k not in ('google_key', 'api_version', 'is_test', 'lead_id', 'form_id', 'gcl_id', 'adgroup_id', 'creative_id');

  select id into v_lead from public.leads where org_id = s.org_id and phone = v_phone and deleted_at is null;
  if v_lead is null then
    select lead_id into v_lead from public.lead_phones where org_id = s.org_id and phone = v_phone;
  end if;

  if v_lead is not null then
    v_status := 'duplicate';
    if s.batch_id is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat) values (s.batch_id, v_lead, s.org_id, true)
      on conflict (batch_id, lead_id) do nothing;
      if found then
        v_status := 'joined';
        insert into public.lead_activities (org_id, lead_id, kind, data)
        values (s.org_id, v_lead, 'batch_joined', jsonb_build_object('batch_id', s.batch_id, 'repeat', true, 'source', s.name));
      end if;
    end if;
  else
    if s.assign_mode <> 'rules' then perform set_config('closeros.skip_distribution', 'on', true); end if;
    insert into public.leads (org_id, name, phone, email, city, state, profession, company, source, campaign, notes, custom, assigned_to)
    values (
      s.org_id, v_name, v_phone, v_email,
      public.pick_lead_field(f, m, 'city', array['city', 'town', 'location']),
      public.pick_lead_field(f, m, 'state', array['state', 'region', 'province']),
      public.pick_lead_field(f, m, 'profession', array['profession', 'occupation', 'job_title', 'what_do_you_do', 'industry', 'business_type', 'work']),
      public.pick_lead_field(f, m, 'company', array['company', 'company_name', 'business_name', 'organisation', 'organization', 'sender_company']),
      coalesce(s.source_label, s.name),
      coalesce(public.pick_lead_field(f, m, 'campaign', array['campaign', 'campaign_name', 'utm_campaign', 'ad_name', 'form_name']), s.campaign),
      public.pick_lead_field(f, m, 'notes', array['message', 'notes', 'comments', 'query', 'enquiry', 'requirement', 'query_message']),
      v_custom,
      case when s.assign_mode = 'user' then s.assign_to else null end
    ) returning id into v_lead;
    perform set_config('closeros.skip_distribution', 'off', true);
    v_minutes := nullif(regexp_replace(coalesce(public.pick_lead_field(f, m, 'watch_minutes', array['watch_minutes']), ''), '[^0-9]', '', 'g'), '')::int;
    if s.batch_id is not null then
      insert into public.batch_leads (batch_id, lead_id, org_id, is_repeat, watch_minutes) values (s.batch_id, v_lead, s.org_id, false, v_minutes)
      on conflict do nothing;
    end if;
    v_status := 'created';
  end if;

  insert into public.lead_source_events (source_id, org_id, payload, status, lead_id) values (s.id, s.org_id, p_payload, v_status, v_lead);
  update public.lead_sources set last_received_at = now(), received_count = received_count + 1 where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_status, 'lead_id', v_lead);
exception when others then
  insert into public.lead_source_events (source_id, org_id, payload, status, error)
  values (s.id, s.org_id, p_payload, 'error', sqlerrm);
  return jsonb_build_object('ok', false, 'error', 'Could not save this lead');
end $$;

-- Only the edge function (service role) may call ingest_lead.
revoke execute on function public.ingest_lead(text, jsonb) from anon, public, authenticated;
revoke execute on function public.flatten_lead_payload(jsonb) from anon, public;
revoke execute on function public.lead_key(text) from anon, public;
grant execute on function public.lead_key(text) to authenticated;
revoke execute on function public.pick_lead_field(jsonb, jsonb, text, text[]) from anon, public;
grant execute on function public.flatten_lead_payload(jsonb) to authenticated;
