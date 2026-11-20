-- Webinar dates typed in one order but read in the other (sheet in US order: 1 Nov stored as 11 Jan). When the parsed
-- day is far from the lead's sign-up but the day/month swap is close to it, the swap is used. Repairs Cancer
-- Consultation Circle's "10/11 Jan 2026" and "10/11 May 2026" webinars (= 1 Nov and 5 Nov 2026).
drop function if exists public.batch_for_text(uuid, text, uuid);
create or replace function public.batch_for_text(p_org uuid, p_raw text, p_source uuid default null, p_ref timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare tz text; w record; v_day date; v_sw date; v_id uuid; v_time time := '19:00'; v_prefix text := 'Webinar'; v_ref date;
begin
  select coalesce(timezone, 'Asia/Kolkata') into tz from public.organizations where id = p_org;
  if p_source is not null then
    select webinar_time, webinar_prefix into v_time, v_prefix from public.lead_sources where id = p_source;
  end if;
  -- an ISO time in UTC (old sheet script) → the company's own day
  if p_raw ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' then p_raw := to_char((p_raw::timestamptz) at time zone tz, 'YYYY-MM-DD'); end if;
  select * into w from public.webinar_parse(p_raw, tz);
  if w.at is null then return null; end if;
  v_day := (w.at at time zone tz)::date;
  if p_ref is not null and extract(day from v_day) <= 12 and extract(day from v_day) <> extract(month from v_day) then
    v_ref := (p_ref at time zone tz)::date;
    if v_day < v_ref - 45 or v_day > v_ref + 120 then
      v_sw := make_date(extract(year from v_day)::int, extract(day from v_day)::int, extract(month from v_day)::int);
      if v_sw between v_ref - 3 and v_ref + 90 then
        w.at := w.at + (v_sw - v_day) * interval '1 day'; v_day := v_sw;
      end if;
    end if;
  end if;
  select id into v_id from public.batches
  where org_id = p_org and not is_archived and (webinar_at at time zone tz)::date = v_day
  order by (kind = 'webinar') desc, auto_created, created_at limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.batches (org_id, name, kind, webinar_at, source_id, auto_created)
  values (p_org, coalesce(nullif(trim(v_prefix), ''), 'Webinar') || ' · ' || to_char(v_day, 'FMDD Mon YYYY'), 'webinar',
    case when w.has_time then w.at else (v_day + coalesce(v_time, '19:00'::time)) at time zone tz end, p_source, true)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.batch_for_text(uuid, text, uuid, timestamptz) from anon, public, authenticated;

-- ingest_lead passes the sign-up time.
do $$ declare d text; begin
  d := pg_get_functiondef('public.ingest_lead(text, jsonb)'::regprocedure);
  d := replace(d, 'public.batch_for_text(s.org_id, f->>public.lead_key(s.webinar_column), s.id)',
                  'public.batch_for_text(s.org_id, f->>public.lead_key(s.webinar_column), s.id, v_signup)');
  execute d;
end $$;

-- Repair: move leads of webinars far before everyone's sign-up into the swapped day.
do $$ declare b record; v_new uuid; tz text; v_sw date; begin
  for b in select x.*, (select min(l.signup_at) from public.batch_leads bl join public.leads l on l.id = bl.lead_id where bl.batch_id = x.id) ref
           from public.batches x where not x.is_archived and x.auto_created loop
    continue when b.ref is null;
    select coalesce(timezone, 'Asia/Kolkata') into tz from public.organizations where id = b.org_id;
    continue when (b.webinar_at at time zone tz)::date >= (b.ref at time zone tz)::date - 45;
    v_new := public.batch_for_text(b.org_id, to_char(b.webinar_at at time zone tz, 'YYYY-MM-DD'), b.source_id, b.ref);
    continue when v_new is null or v_new = b.id;
    update public.batch_leads bl set batch_id = v_new where bl.batch_id = b.id
      and not exists (select 1 from public.batch_leads o where o.batch_id = v_new and o.lead_id = bl.lead_id);
    delete from public.batch_leads where batch_id = b.id;
    update public.batches set is_archived = true where id = b.id;
    perform public.relink_calls(v_new);
  end loop;
end $$;

-- The UTC copies ("10 Jan" = 11 Jan IST, "10 May" = 11 May IST) of the same two webinars.
do $$ declare o uuid := '689fe1e2-9fcc-4218-829a-097d23955b64'; p record; v_from uuid; v_to uuid; begin
  for p in select * from (values ('Webinar · 10 Jan 2026', 'Webinar · 1 Nov 2026'), ('Webinar · 10 May 2026', 'Webinar · 5 Nov 2026')) t(a, b) loop
    select id into v_from from public.batches where org_id = o and name = p.a and not is_archived;
    select id into v_to from public.batches where org_id = o and name = p.b and not is_archived;
    continue when v_from is null or v_to is null;
    update public.batch_leads bl set batch_id = v_to where bl.batch_id = v_from
      and not exists (select 1 from public.batch_leads x where x.batch_id = v_to and x.lead_id = bl.lead_id);
    delete from public.batch_leads where batch_id = v_from;
    update public.batches set is_archived = true where id = v_from;
    perform public.relink_calls(v_to);
  end loop;
end $$;
