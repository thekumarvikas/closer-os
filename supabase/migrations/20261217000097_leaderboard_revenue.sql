-- Round 15 · 8b) Leaderboard can be sorted by sales value too (owner: calls, talk time, revenue, sales).
CREATE OR REPLACE FUNCTION public.leaderboard(p_org uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'sales', (select count(*) from public.sales vs where vs.org_id = p_org and vs.credited_to = m.user_id and vs.status = 'verified'
        and vs.sold_at >= p_from and vs.sold_at < p_to),
      'revenue', (select coalesce(sum(vs.amount), 0) from public.sales vs where vs.org_id = p_org and vs.credited_to = m.user_id and vs.status = 'verified'
        and vs.sold_at >= p_from and vs.sold_at < p_to)) as x
    from public.org_members m join public.profiles p on p.id = m.user_id
    left join public.calls c on c.user_id = m.user_id and c.org_id = p_org and c.started_at >= p_from and c.started_at < p_to
    left join public.call_outcomes o on o.id = c.outcome_id
    where m.org_id = p_org and m.status = 'active'
    group by m.user_id, m.role, p.full_name, p.email
    having m.role in ('rep', 'manager') or count(c.id) > 0) t;
  return res;
end $function$;
