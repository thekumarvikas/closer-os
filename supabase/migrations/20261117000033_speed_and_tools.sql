-- Speed for 50 reps × 3,000 leads/month, plus: bulk lead actions, leaderboard, best time to call,
-- recording retention (auto-delete after N days).
alter type public.recording_status add value if not exists 'expired';

-- ───────────── Faster search & lists ─────────────
create or replace function public.lead_search_text(l public.leads)
returns text language sql immutable set search_path = '' as $$
  select lower(coalesce(l.name, '') || ' ' || coalesce(l.email, '') || ' ' || coalesce(l.company, '') || ' ' || coalesce(l.profession, '') || ' ' ||
    coalesce(l.city, '') || ' ' || coalesce(l.state, '') || ' ' || coalesce(l.source, '') || ' ' || coalesce(l.campaign, '') || ' ' ||
    coalesce(l.key_facts, '') || ' ' || coalesce(l.notes, '') || ' ' || coalesce(l.custom::text, ''))
$$;
create index if not exists leads_search_trgm on public.leads using gin (public.lead_search_text(leads) extensions.gin_trgm_ops) where deleted_at is null;
create index if not exists leads_phone_trgm on public.leads using gin (phone extensions.gin_trgm_ops) where deleted_at is null;
create index if not exists leads_org_created on public.leads (org_id, created_at desc) where deleted_at is null;
create index if not exists leads_org_assigned_at on public.leads (org_id, assigned_to, assigned_at) where deleted_at is null;
create index if not exists leads_org_outcome on public.leads (org_id, last_outcome_id) where deleted_at is null;
create index if not exists lead_notes_trgm on public.lead_activities using gin (lower(data->>'text') extensions.gin_trgm_ops) where kind = 'note';
create index if not exists calls_notes_trgm on public.calls using gin (lower(notes) extensions.gin_trgm_ops) where notes is not null;
create index if not exists follow_ups_org_due on public.follow_ups (org_id, due_at);
create index if not exists ann_acks_user on public.announcement_acks (user_id) where acked_at is null;
create index if not exists calls_recording_age on public.calls (org_id, started_at) where recording_status = 'uploaded';

create or replace function public.search_leads(p_org uuid, p_q text, p_limit int default 300)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(trim(coalesce(p_q, ''))); digits text; v_rep boolean; res uuid[];
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if length(q) < 2 then return '{}'; end if;
  digits := regexp_replace(q, '\D', '', 'g');
  v_rep := public.org_role(p_org) = 'rep';
  select array_agg(id) into res from (
    select id from (
      select l.id, l.updated_at from public.leads l
      where l.org_id = p_org and l.deleted_at is null and public.lead_search_text(l) like '%' || q || '%'
      union
      select l.id, l.updated_at from public.leads l
      where length(digits) >= 4 and l.org_id = p_org and l.deleted_at is null and l.phone like '%' || digits || '%'
      union
      select l.id, l.updated_at from public.lead_activities a join public.leads l on l.id = a.lead_id
      where a.kind = 'note' and a.org_id = p_org and lower(a.data->>'text') like '%' || q || '%' and l.deleted_at is null
      union
      select l.id, l.updated_at from public.calls c join public.leads l on l.id = c.lead_id
      where c.org_id = p_org and c.notes is not null and lower(c.notes) like '%' || q || '%' and l.deleted_at is null
    ) m
    where not v_rep or exists (select 1 from public.leads x where x.id = m.id and (x.assigned_to = auth.uid()
          or exists (select 1 from public.batch_leads b where b.lead_id = x.id and b.reminder_by = auth.uid())))
    order by updated_at desc limit p_limit) t;
  return coalesce(res, '{}');
end $$;

-- ───────────── Bulk actions on leads (dashboard) ─────────────
create or replace function public.bulk_update_leads(p_org uuid, p_ids uuid[], p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_org_manager(p_org) then raise exception 'Only managers can change many leads at once'; end if;
  if cardinality(p_ids) > 5000 then raise exception 'Choose at most 5,000 leads at a time'; end if;
  if p ? 'delete' then
    update public.leads set deleted_at = now() where org_id = p_org and id = any(p_ids) and deleted_at is null;
    get diagnostics n = row_count;
  else
    update public.leads set
      stage_id = case when p ? 'stage_id' then nullif(p->>'stage_id', '')::uuid else stage_id end,
      assigned_to = case when p ? 'assigned_to' then nullif(p->>'assigned_to', '')::uuid else assigned_to end,
      do_not_call = case when p ? 'do_not_call' then (p->>'do_not_call')::boolean else do_not_call end,
      tags = case when p ? 'add_tag' and not (p->>'add_tag' = any(tags)) then tags || (p->>'add_tag')
                  when p ? 'remove_tag' then array_remove(tags, p->>'remove_tag') else tags end
    where org_id = p_org and id = any(p_ids) and deleted_at is null;
    get diagnostics n = row_count;
  end if;
  perform public.write_audit(p_org, 'leads_bulk_update', 'lead', null, p || jsonb_build_object('count', n));
  return n;
end $$;

-- ───────────── Leaderboard (everyone in the company sees the ranking) ─────────────
create or replace function public.leaderboard(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  if coalesce((select (settings->>'show_leaderboard')::boolean from public.organizations where id = p_org), true) = false
     and not public.is_org_manager(p_org) then return '[]'; end if;
  select coalesce(jsonb_agg(x order by (x->>'talk_sec')::int desc), '[]') into res from (
    select jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1)),
      'calls', count(c.id) filter (where c.direction = 'outgoing'),
      'conversations', count(c.id) filter (where c.duration_sec > 0),
      'talk_sec', coalesce(sum(c.duration_sec), 0),
      'sales', count(c.id) filter (where o.category = 'won')) as x
    from public.org_members m join public.profiles p on p.id = m.user_id
    left join public.calls c on c.user_id = m.user_id and c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
    left join public.call_outcomes o on o.id = c.outcome_id
    where m.org_id = p_org and m.status = 'active'
    group by m.user_id, m.role, p.full_name, p.email
    having m.role in ('rep', 'manager') or count(c.id) > 0) t;
  return res;
end $$;

-- ───────────── Best time to call ─────────────
-- For a lead: the hour they picked up most often. Otherwise: the company's best hour (last 30 days).
create or replace function public.best_time_to_call(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_tz text; r record;
begin
  if not public.lead_visible(p_lead) then raise exception 'Lead not found'; end if;
  select l.org_id, o.timezone into v_org, v_tz from public.leads l join public.organizations o on o.id = l.org_id where l.id = p_lead;
  select extract(hour from started_at at time zone v_tz)::int hr, count(*) filter (where duration_sec > 0) ok, count(*) n into r
  from public.calls where lead_id = p_lead group by 1 having count(*) filter (where duration_sec > 0) > 0
  order by count(*) filter (where duration_sec > 0) desc, count(*) desc limit 1;
  if r.hr is not null then
    return jsonb_build_object('hour', r.hr, 'source', 'lead', 'picked', r.ok, 'tries', r.n);
  end if;
  select extract(hour from started_at at time zone v_tz)::int hr, count(*) filter (where duration_sec > 0) ok, count(*) n into r
  from public.calls where org_id = v_org and direction = 'outgoing' and started_at > now() - interval '30 days'
  group by 1 having count(*) >= 20 order by count(*) filter (where duration_sec > 0)::numeric / count(*) desc limit 1;
  if r.hr is null then return null; end if;
  return jsonb_build_object('hour', r.hr, 'source', 'team', 'rate', round(r.ok * 100.0 / r.n));
end $$;

-- ───────────── Recording retention ─────────────
-- organizations.settings.recording_retention_days (null = keep for ever). A daily job lists expired
-- recordings; the cleanup function deletes the files and marks the calls 'expired'.
create or replace function public.expired_recordings(p_limit int default 500)
returns table (call_id uuid, path text) language sql stable security definer set search_path = '' as $$
  select c.id, c.recording_path from public.calls c join public.organizations o on o.id = c.org_id
  where c.recording_status = 'uploaded' and c.recording_path is not null
    and (o.settings->>'recording_retention_days') ~ '^[0-9]+$'
    and c.started_at < now() - make_interval(days => (o.settings->>'recording_retention_days')::int)
  limit p_limit
$$;
create or replace function public.mark_recordings_expired(p_ids uuid[])
returns void language sql security definer set search_path = '' as $$
  update public.calls set recording_status = 'expired', recording_path = null where id = any(p_ids)
$$;
revoke execute on function public.expired_recordings(int) from anon, public, authenticated;
revoke execute on function public.mark_recordings_expired(uuid[]) from anon, public, authenticated;

select cron.unschedule('recording-cleanup') where exists (select 1 from cron.job where jobname = 'recording-cleanup');
select cron.schedule('recording-cleanup', '17 21 * * *', $job$
  select net.http_post(
    url := 'https://tdbqgoxxxfkfttdznzhb.supabase.co/functions/v1/recording-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'indiamart_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 55000)
  where exists (select 1 from public.organizations where (settings->>'recording_retention_days') ~ '^[0-9]+$')
$job$);

do $$ declare f text; begin
  foreach f in array array['bulk_update_leads(uuid, uuid[], jsonb)', 'leaderboard(uuid, timestamptz, timestamptz)', 'best_time_to_call(uuid)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
