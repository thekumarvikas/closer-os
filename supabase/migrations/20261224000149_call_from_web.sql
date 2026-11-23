-- 📞 next to every phone number on the website (owner, Nov 24 2026): the click sends THAT number to the person's
-- Closer OS app (same as "Call on my phone" in My desk). The number may be a lead's second number.
alter table public.call_requests add column if not exists phone text;

drop function if exists public.request_call(uuid, text, uuid);
create or replace function public.request_call(p_lead uuid, p_purpose text default null, p_batch uuid default null, p_phone text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_org uuid; v_id uuid; v_ctx jsonb;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select org_id into v_org from public.leads where id = p_lead and deleted_at is null;
  if exists (select 1 from public.leads where id = p_lead and do_not_call) then raise exception 'This lead is marked Do Not Call'; end if;
  if p_purpose is null then v_ctx := public.lead_call_context(p_lead); end if;
  update public.call_requests set status = 'cancelled', updated_at = now() where user_id = auth.uid() and status = 'pending';
  insert into public.call_requests (org_id, user_id, lead_id, purpose, batch_id, phone)
  values (v_org, auth.uid(), p_lead, coalesce(p_purpose, v_ctx->>'purpose', 'sales'), coalesce(p_batch, nullif(v_ctx->>'batch_id', '')::uuid),
          nullif(trim(coalesce(p_phone, '')), ''))
  returning id into v_id;
  -- Wake the phone (push): it shows "📞 Call … — tap to call" when Closer OS isn't open.
  begin perform public.push_wake(v_org, auth.uid(), 'call'); exception when others then null; end;
  return v_id;
end $$;

-- A number shown anywhere (call log, lists): find its lead (main or second number), then ask my phone to dial it.
create or replace function public.request_call_phone(p_org uuid, p_phone text, p_lead uuid default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_lead uuid := p_lead; v_prefix text; v_phone text;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select phone_prefix into v_prefix from public.organizations where id = p_org;
  v_phone := public.normalize_phone(p_phone, v_prefix);
  if v_lead is null then v_lead := public.find_lead(p_org, v_phone, null); end if;
  if v_lead is null then raise exception 'This number is not in your leads yet — add it as a lead first'; end if;
  return jsonb_build_object('id', public.request_call(v_lead, null, null, v_phone), 'lead_id', v_lead);
end $$;

create or replace function public.claim_call_request() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare r public.call_requests;
begin
  update public.call_requests set status = 'cancelled', updated_at = now()
  where user_id = auth.uid() and status = 'pending' and created_at < now() - interval '2 minutes';
  update public.call_requests set status = 'dialing', updated_at = now()
  where id = (select id from public.call_requests where user_id = auth.uid() and status = 'pending' order by created_at desc limit 1)
  returning * into r;
  if r.id is null then return null; end if;
  return jsonb_build_object('id', r.id, 'lead_id', r.lead_id, 'purpose', r.purpose, 'batch_id', r.batch_id, 'phone', r.phone);
end $$;
grant execute on function public.request_call(uuid, text, uuid, text), public.request_call_phone(uuid, text, uuid) to authenticated;
