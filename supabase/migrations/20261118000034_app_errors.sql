-- Crash and error reports from the app, so problems on reps' phones are seen (Super Admin page).
create table if not exists public.app_errors (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  device_id text, app_version text, model text, android text,
  kind text not null default 'error' check (kind in ('crash', 'error')),
  place text, message text, stack text,
  happened_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists app_errors_created on public.app_errors (created_at desc);
alter table public.app_errors enable row level security;   -- no direct access; only via the functions below

-- The app sends a batch (also before login, e.g. a crash on the login screen). Sizes are capped.
create or replace function public.report_app_errors(p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare r jsonb; n int := 0; v_org uuid;
begin
  if jsonb_typeof(p) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p) limit 50 loop
    v_org := nullif(r->>'org_id', '')::uuid;
    if v_org is not null and (auth.uid() is null or not public.is_org_member(v_org)) then v_org := null; end if;
    insert into public.app_errors (org_id, user_id, device_id, app_version, model, android, kind, place, message, stack, happened_at)
    values (v_org, auth.uid(), left(r->>'device_id', 64), left(r->>'app_version', 20), left(r->>'model', 80), left(r->>'android', 10),
      case when r->>'kind' = 'crash' then 'crash' else 'error' end, left(r->>'place', 120), left(r->>'message', 500), left(r->>'stack', 6000),
      coalesce(nullif(r->>'at', '')::timestamptz, now()));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.report_app_errors(jsonb) from public;
grant execute on function public.report_app_errors(jsonb) to anon, authenticated;

create or replace function public.sa_app_errors(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'groups', (select coalesce(jsonb_agg(g order by (g->>'count')::int desc), '[]') from (
      select jsonb_build_object('kind', kind, 'place', place, 'message', message, 'count', count(*), 'phones', count(distinct device_id),
        'last', max(happened_at), 'versions', array_agg(distinct app_version), 'stack', (array_agg(stack order by happened_at desc))[1]) g
      from public.app_errors where created_at > now() - make_interval(days => p_days) group by kind, place, message) t),
    'recent', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('at', e.happened_at, 'kind', e.kind, 'place', e.place, 'message', e.message, 'model', e.model, 'android', e.android,
        'app_version', e.app_version, 'company', o.name, 'user', p.email) x
      from public.app_errors e left join public.organizations o on o.id = e.org_id left join public.profiles p on p.id = e.user_id
      order by e.created_at desc limit 100) t)
  ) into res;
  return res;
end $$;
revoke execute on function public.sa_app_errors(int) from anon, public;
grant execute on function public.sa_app_errors(int) to authenticated;

-- Keep 60 days.
select cron.unschedule('app-errors-cleanup') where exists (select 1 from cron.job where jobname = 'app-errors-cleanup');
select cron.schedule('app-errors-cleanup', '41 20 * * *', $$delete from public.app_errors where created_at < now() - interval '60 days'$$);
