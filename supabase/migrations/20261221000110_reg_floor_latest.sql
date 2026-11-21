-- The registered-again priority applies to the person's NEWEST webinar only (older webinars' Hot counts stay true).
create or replace function public.reg_floor_lead(p_lead uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare n int; v_batch uuid;
begin
  select count(*) into n from public.batch_leads bl join public.batches b on b.id = bl.batch_id
  where bl.lead_id = p_lead and not b.is_archived and coalesce(bl.registered, true);
  update public.leads set reg_count = n where id = p_lead and reg_count is distinct from n;
  if n < 2 then return; end if;
  select bl.batch_id into v_batch from public.batch_leads bl join public.batches b on b.id = bl.batch_id
  where bl.lead_id = p_lead and not b.is_archived order by b.webinar_at desc nulls last limit 1;
  update public.batch_leads bl set
    warmth = greatest(coalesce(bl.warmth, 0), case when n >= 3 then 70 else 40 end),
    warm_reason = case
      when coalesce(bl.warmth, 0) < case when n >= 3 then 70 else 40 end
        then (case when n >= 3 then '🔥 Hot · 70' else 'Warm · 40' end) || ' · 🔁 registered ' || n || '×'
          || coalesce(' · ' || nullif(regexp_replace(regexp_replace(coalesce(bl.warm_reason, ''), '\s*·?\s*🔁 registered \d+×', '', 'g'), '^[^·]*·[^·]*(·\s*)?', ''), ''), '')
      when coalesce(bl.warm_reason, '') ~ '🔁 registered' then regexp_replace(bl.warm_reason, '🔁 registered \d+×', '🔁 registered ' || n || '×')
      else coalesce(bl.warm_reason, '') || ' · 🔁 registered ' || n || '×' end
  where bl.lead_id = p_lead and bl.batch_id = v_batch;
end $$;
revoke all on function public.reg_floor_lead(uuid) from public, anon, authenticated;

-- Recompute every webinar that got the floor on an older row (recompute = true warmth, then the floor on the newest).
do $$ declare r record; begin
  for r in select distinct batch_id from public.batch_leads where warm_reason ~ '🔁 registered' loop
    perform public.batch_recompute(r.batch_id);
  end loop;
end $$;
