-- IndiaMART: pull new enquiries with the seller's CRM key every 10 minutes (pg_cron → edge function
-- indiamart-pull → ingest_lead). The cron call is authorised with a random secret kept in Vault.
alter table public.lead_sources drop constraint if exists lead_sources_kind_check;
alter table public.lead_sources add constraint lead_sources_kind_check
  check (kind in ('webhook', 'zapier', 'pabbly', 'flexifunnels', 'google_ads', 'google_sheets', 'facebook', 'indiamart'));
alter table public.lead_sources add column if not exists api_key text;
alter table public.lead_sources add column if not exists pulled_until timestamptz;
alter table public.lead_sources add column if not exists last_pull_at timestamptz;
alter table public.lead_sources add column if not exists last_pull_error text;

create extension if not exists pg_net;
create extension if not exists pg_cron;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'indiamart_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'indiamart_cron_secret', 'Authorises the IndiaMART pull job');
  end if;
end $$;

-- Only the edge function (service role) checks the secret; it is never returned.
create or replace function public.check_cron_secret(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'indiamart_cron_secret' and decrypted_secret = p)
$$;
revoke execute on function public.check_cron_secret(text) from anon, public, authenticated;

-- Sources the job should pull.
create or replace function public.indiamart_sources()
returns setof public.lead_sources language sql stable security definer set search_path = '' as $$
  select * from public.lead_sources where kind = 'indiamart' and is_active and coalesce(api_key, '') <> ''
$$;
revoke execute on function public.indiamart_sources() from anon, public, authenticated;

create or replace function public.indiamart_pulled(p_source uuid, p_until timestamptz, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.lead_sources set last_pull_at = now(), last_pull_error = p_error,
    pulled_until = case when p_error is null then p_until else pulled_until end where id = p_source
$$;
revoke execute on function public.indiamart_pulled(uuid, timestamptz, text) from anon, public, authenticated;

select cron.unschedule('indiamart-pull') where exists (select 1 from cron.job where jobname = 'indiamart-pull');
select cron.schedule('indiamart-pull', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://tdbqgoxxxfkfttdznzhb.supabase.co/functions/v1/indiamart-pull',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'indiamart_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 55000)
  where exists (select 1 from public.lead_sources where kind = 'indiamart' and is_active and coalesce(api_key, '') <> '')
$job$);
