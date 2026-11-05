-- Which calls an outcome appears on: dialled calls, received calls, or both (managers can change it).
alter table public.call_outcomes add column if not exists shown_on text not null default 'both'
  check (shown_on in ('both', 'outgoing', 'incoming'));

-- Outcomes that only make sense when WE dialled: couldn't reach them, dead numbers, someone else
-- answering our call, "busy, call later", hung up after our introduction.
create or replace function public.outcome_default_shown_on(p_code text, p_category text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_category = 'not_connected' then 'outgoing'
    when p_code in ('not_in_service', 'invalid_number', 'r_invalid', 'r_out_of_service', 'someone_else', 'r_someone_else',
                    'call_back', 'r_call_later', 'disconnected', 'r_disconnected', 'cut_call', 'r_cut_call', 'busy', 'r_busy',
                    'no_answer', 'r_didnt_pick', 'r_switched_off', 'r_not_reachable', 'r_incoming_na', 'incoming_na') then 'outgoing'
    else 'both' end
$$;

update public.call_outcomes set shown_on = public.outcome_default_shown_on(code, category::text) where shown_on = 'both';

-- New companies / new outcomes get the same sensible default.
create or replace function public.t_outcome_shown_on() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.shown_on = 'both' then new.shown_on := public.outcome_default_shown_on(new.code, new.category::text); end if;
  return new;
end $$;
drop trigger if exists t_outcome_shown_on on public.call_outcomes;
create trigger t_outcome_shown_on before insert on public.call_outcomes for each row execute function public.t_outcome_shown_on();
