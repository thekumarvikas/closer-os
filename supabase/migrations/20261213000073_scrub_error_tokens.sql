-- Older app versions sent error texts that contained the request headers (login token). Scrub on arrival.
create or replace function public.t_scrub_error_tokens()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.message := regexp_replace(regexp_replace(coalesce(new.message, ''), 'eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+){0,2}', '[hidden]', 'g'), 'sb_(publishable|secret)_[A-Za-z0-9_-]+', '[hidden]', 'g');
  new.stack := regexp_replace(regexp_replace(coalesce(new.stack, ''), 'eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+){0,2}', '[hidden]', 'g'), 'sb_(publishable|secret)_[A-Za-z0-9_-]+', '[hidden]', 'g');
  return new;
end $$;
drop trigger if exists t_scrub_error_tokens on public.app_errors;
create trigger t_scrub_error_tokens before insert or update on public.app_errors for each row execute function public.t_scrub_error_tokens();

create or replace function public.t_scrub_device_error()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.rec_last_error ~ 'eyJ[A-Za-z0-9_-]{8,}' then new.rec_last_error := 'Upload failed (details hidden)'; end if;
  return new;
end $$;
drop trigger if exists t_scrub_device_error on public.device_status;
create trigger t_scrub_device_error before insert or update on public.device_status for each row execute function public.t_scrub_device_error();
