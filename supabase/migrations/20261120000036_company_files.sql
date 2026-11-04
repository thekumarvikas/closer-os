-- Company file library: brochures, price lists, photos, videos that reps send on WhatsApp from the
-- app without having them on their own phone. Files live in the private bucket template-media at
-- <org>/files/<name> (members read, managers upload/delete — existing storage policies).
create table if not exists public.company_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  path text not null,
  mime_type text,
  size_bytes bigint,
  position int not null default 0,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists company_files_org on public.company_files (org_id, position, created_at);
alter table public.company_files enable row level security;
drop policy if exists company_files_read on public.company_files;
create policy company_files_read on public.company_files for select to authenticated using (public.is_org_member(org_id));
drop policy if exists company_files_write on public.company_files;
create policy company_files_write on public.company_files for all to authenticated
  using (public.is_org_manager(org_id)) with check (public.is_org_manager(org_id));
