-- Daily summary: 'live' (today so far + usual by this clock time) and exact covered time on every report (owner, Nov 24).
CREATE OR REPLACE FUNCTION public.daily_summary(p_org uuid, p_kind text, p_day date DEFAULT NULL::date, p_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cut timestamptz; v_usual jsonb; v_tz text; v_users uuid[]; v_day date; v_plan date; a timestamptz; b timestamptz; pa timestamptz; pb timestamptz; v_team boolean;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from public.organizations where id = p_org;
  v_team := public.is_org_manager(p_org) and p_user is null;
  if v_team then v_users := public.visible_user_ids(p_org);
  elsif p_user is not null and p_user <> auth.uid() then
    if not (p_user = any(public.visible_user_ids(p_org))) then raise exception 'Not allowed'; end if;
    v_users := array[p_user];
  else v_users := array[auth.uid()]; end if;
  -- morning: results of yesterday + plan for today · evening: results of today + plan for tomorrow
  v_day := coalesce(p_day, (now() at time zone v_tz)::date - case when p_kind = 'morning' then 1 else 0 end);
  v_plan := v_day + 1;
  a := v_day::timestamp at time zone v_tz; b := (v_day + 1)::timestamp at time zone v_tz;
  pa := v_plan::timestamp at time zone v_tz; pb := (v_plan + 1)::timestamp at time zone v_tz;
  -- live = today so far; plan = the rest of today. End of day ('evening') = today up to the moment it is made
  -- (every late call counts — owner, Nov 24); morning = yesterday's whole day.
  v_cut := least(b, now());
  if p_kind = 'live' then
    pa := now(); pb := b;
    -- "your usual by this time": average of the last 7 days that had calls, cut at the same clock time.
    select jsonb_build_object('days', count(*),
      'dialled', round(avg((s->>'dialled')::numeric)), 'connected', round(avg((s->>'connected')::numeric)),
      'talk', round(avg((s->>'talk')::numeric)), 'received', round(avg((s->>'received')::numeric)),
      'leads_connected', round(avg((s->>'leads_connected')::numeric)), 'sales', round(avg((s->>'sales')::numeric), 1))
      into v_usual
      from (select public.day_stats(p_org, v_users, ((v_day - i)::timestamp at time zone v_tz), ((v_day - i)::timestamp at time zone v_tz) + (now() - a), v_tz) s
              from generate_series(1, 14) i) x
     where (s->>'dialled')::int + (s->>'received')::int > 0;
  end if;
  return jsonb_build_object(
    'kind', p_kind, 'day', v_day, 'plan_day', v_plan, 'tz', v_tz, 'team', v_team,
    'org_name', (select name from public.organizations where id = p_org),
    'who', case when v_team then null else (select full_name from public.profiles where id = v_users[1]) end,
    'working_day', exists (select 1 from public.working_days(p_org, case when v_team then null else v_users[1] end, v_plan, v_plan)),
    'covers_from', a, 'covers_to', case when p_kind = 'morning' then b else v_cut end, 'made_at', now(),
    'complete', p_kind = 'morning' or now() >= b, 'usual', v_usual,
    'stats', public.day_stats(p_org, v_users, a, b, v_tz),
    'people', case when v_team then coalesce((select jsonb_agg(jsonb_build_object('user_id', u, 'name', p.full_name, 'email', p.email, 'stats', public.day_stats(p_org, array[u], a, b, v_tz))
                  order by p.full_name)
                from unnest(v_users) u join public.profiles p on p.id = u
                join public.org_members m on m.org_id = p_org and m.user_id = u and m.status = 'active' and coalesce(m.call_team, 'both') <> 'none'), '[]') else null end,
    'plan', jsonb_build_object(
      'follow_ups', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending' and due_at >= pa and due_at < pb),
      'overdue', (select count(*) from public.follow_ups where org_id = p_org and assigned_to = any(v_users) and status = 'pending' and due_at < pa),
      'hot', public.hot_leads(p_org, v_users, 50),
      'no_next', (select count(*) from public.leads l join public.call_outcomes o on o.id = l.last_outcome_id
               where l.org_id = p_org and l.assigned_to = any(v_users) and l.deleted_at is null and l.won_at is null
                 and o.category = 'positive' and l.next_follow_up_at is null),
      'webinars', coalesce((select jsonb_agg(jsonb_build_object('name', bb.name, 'at', bb.webinar_at,
                 'leads', (select count(*) from public.batch_leads bl join public.leads l on l.id = bl.lead_id
                           where bl.batch_id = bb.id and coalesce(bl.reminder_by, l.assigned_to) = any(v_users))) order by bb.webinar_at)
                 from public.batches bb where bb.org_id = p_org and not bb.is_archived and bb.webinar_at >= pa and bb.webinar_at < pb), '[]'))
  );
end $function$
;
