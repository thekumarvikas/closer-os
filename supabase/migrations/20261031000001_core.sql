-- Closer OS core schema (Phase 1)
-- Companies, people, roles, teams, leads, calls, follow-ups, audit log.
-- Access rules live in the database (row level security), not only in the apps.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ───────────────────────── Types ─────────────────────────
create type public.member_role as enum ('owner', 'admin', 'manager', 'rep');
create type public.member_status as enum ('active', 'deactivated');
create type public.call_direction as enum ('outgoing', 'incoming', 'missed', 'rejected');
create type public.recording_status as enum ('not_expected', 'pending', 'uploaded', 'missing', 'failed', 'disabled');
create type public.follow_up_status as enum ('pending', 'done', 'cancelled');
create type public.outcome_category as enum ('not_connected', 'connected', 'positive', 'won', 'lost', 'invalid');
create type public.distribution_method as enum ('manual', 'round_robin', 'rule');

-- ───────────────────────── Companies and people ─────────────────────────
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  country_code text not null default 'IN',          -- ISO 3166-1 alpha-2
  phone_prefix text not null default '+91',
  currency text not null default 'INR',              -- ISO 4217
  timezone text not null default 'Asia/Kolkata',     -- IANA
  date_format text not null default 'DD/MM/YYYY',
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  phone text,
  avatar_url text,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'rep',
  status public.member_status not null default 'active',
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.org_members (user_id);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- A rep can be in several teams; a team can have several managers.
create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  is_manager boolean not null default false,
  primary key (team_id, user_id)
);
create index on public.team_members (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.member_role not null default 'rep',
  team_ids uuid[] not null default '{}',
  token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  invited_by uuid references auth.users(id),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on public.invitations (org_id);
create index on public.invitations (lower(email));

-- ───────────────────────── Per-company settings ─────────────────────────
create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  position int not null default 0,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  is_active boolean not null default true,
  unique (org_id, name)
);

-- Call outcomes ("dispositions"), editable per company.
create table public.call_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  label text not null,
  category public.outcome_category not null,
  -- Extra fields the app shows: 'follow_up', 'interest', 'sale'
  form text,
  position int not null default 0,
  is_active boolean not null default true,
  unique (org_id, code)
);

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null,
  field_type text not null check (field_type in ('text', 'number', 'date', 'select', 'boolean')),
  options jsonb not null default '[]'::jsonb,
  position int not null default 0,
  is_active boolean not null default true,
  unique (org_id, key)
);

-- ───────────────────────── Phone numbers ─────────────────────────
-- Turns any written phone number into +<country><number>. Ten-digit numbers get the
-- company's default prefix; a leading 0 trunk prefix is dropped.
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
  if p <> '' and left(d, 1) = '0' and length(d) = 11 then return '+' || p || substr(d, 2); end if;
  if p <> '' and length(d) = 10 then return '+' || p || d; end if;
  if p <> '' and left(d, length(p)) = p and length(d) > 10 then return '+' || d; end if;
  return '+' || d;
end $$;

-- ───────────────────────── Leads ─────────────────────────
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default '',
  phone text not null,                  -- normalised, +919876543210
  email text,
  country text, state text, city text, timezone text,
  profession text, company text,
  source text, campaign text,
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_at timestamptz,
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  deal_value numeric(14, 2),
  currency text,
  tags text[] not null default '{}',
  custom jsonb not null default '{}'::jsonb,
  notes text,
  last_call_at timestamptz,
  last_outcome_id uuid references public.call_outcomes(id) on delete set null,
  next_follow_up_at timestamptz,
  last_summary text,
  key_objection text,
  referred_by_lead_id uuid references public.leads(id) on delete set null,
  do_not_call boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- One live lead per phone number per company (duplicate detection).
create unique index leads_org_phone_uq on public.leads (org_id, phone) where deleted_at is null;
create index leads_assignee_idx on public.leads (org_id, assigned_to, next_follow_up_at) where deleted_at is null;
create index leads_updated_idx on public.leads (org_id, updated_at);
create index leads_name_trgm on public.leads using gin (name extensions.gin_trgm_ops);

-- Alternate numbers (a lead may give a second number).
create table public.lead_phones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  phone text not null,
  label text,
  created_at timestamptz not null default now(),
  unique (org_id, phone)
);
create index on public.lead_phones (lead_id);

-- Timeline of everything that happened to a lead.
create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null,        -- created, assigned, call, note, stage_changed, follow_up, imported…
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.lead_activities (lead_id, created_at desc);

-- ───────────────────────── Calls ─────────────────────────
create table public.calls (
  -- Generated on the phone so a retried upload never creates a second row.
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text,
  direction public.call_direction not null,
  phone text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_sec int not null default 0 check (duration_sec >= 0),
  sim_slot int,
  sim_label text,
  outcome_id uuid references public.call_outcomes(id) on delete set null,
  outcome_data jsonb not null default '{}'::jsonb,   -- interest level, sale amount, etc.
  notes text,
  from_dialer_queue boolean not null default false,
  recording_status public.recording_status not null default 'not_expected',
  recording_path text,
  recording_size_bytes bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calls_user_time_idx on public.calls (org_id, user_id, started_at desc);
create index calls_lead_idx on public.calls (lead_id, started_at desc);
create index calls_org_time_idx on public.calls (org_id, started_at desc);

-- ───────────────────────── Follow-ups ─────────────────────────
create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  assigned_to uuid not null references auth.users(id) on delete cascade,
  due_at timestamptz not null,
  status public.follow_up_status not null default 'pending',
  priority smallint not null default 2 check (priority between 1 and 3),  -- 1 high, 3 low
  reason text,
  notes text,
  call_id uuid references public.calls(id) on delete set null,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index follow_ups_due_idx on public.follow_ups (org_id, assigned_to, status, due_at);
create index on public.follow_ups (lead_id);

-- ───────────────────────── Lead distribution ─────────────────────────
create table public.distribution_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  method public.distribution_method not null default 'round_robin',
  -- For 'rule': match on lead fields, e.g. {"source": "facebook", "campaign": "Webinar Oct"}
  conditions jsonb not null default '{}'::jsonb,
  user_ids uuid[] not null default '{}',
  rr_cursor int not null default 0,
  priority int not null default 100,     -- lower runs first
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.distribution_rules (org_id, is_active, priority);

-- ───────────────────────── Audit log ─────────────────────────
create table public.audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity text,
  entity_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_logs (org_id, created_at desc);
