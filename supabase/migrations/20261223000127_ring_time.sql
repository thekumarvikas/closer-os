-- Ringing time (owner, Nov 23 2026): seconds the call rang before it was answered or dropped.
-- Measured by the app from the phone's call states (RINGING → OFFHOOK → IDLE) and sent after the call is synced.
alter table public.calls add column if not exists ring_sec int;

create or replace function public.set_call_ring(p_rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if jsonb_array_length(p_rows) > 500 then raise exception 'Send at most 500 at a time'; end if;
  update public.calls c set ring_sec = least(600, greatest(0, (r->>'ring_sec')::int))
  from jsonb_array_elements(p_rows) r
  where c.id = (r->>'id')::uuid and c.user_id = auth.uid() and (r->>'ring_sec') is not null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.set_call_ring(jsonb) from public, anon;
grant execute on function public.set_call_ring(jsonb) to authenticated;
