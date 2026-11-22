-- Hot leads per team member per category (one-page summary image).
create or replace function public.hot_leads(p_org uuid, p_users uuid[], p_limit int default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with team as (
    select lower(p.email) email, public.phone_key(p.phone) pk, lower(trim(p.full_name)) nm
    from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = p_org
    union select null, public.phone_key(s.sim_number), null from public.member_sims s where s.org_id = p_org
  ), cand as (
    select l.*, o.category::text ocat, o.code ocode, o.label olabel
    from public.leads l left join public.call_outcomes o on o.id = l.last_outcome_id
    where l.org_id = p_org and l.assigned_to = any(p_users) and l.deleted_at is null and l.won_at is null
      and not coalesce(l.do_not_call, false)
      and coalesce(o.category::text, '') not in ('lost', 'invalid', 'won')
      and coalesce(l.intent, '') not in ('cold', 'nofit')
      and (l.intent in ('ready','hot','interested','approval','price','later') or o.category::text = 'positive'
           or o.code ~ 'call_back|call_later'
           or exists (select 1 from public.batch_leads bl where bl.lead_id = l.id and (coalesce(bl.watch_minutes, 0) > 0 or bl.attended)))
      and not exists (select 1 from team t where (t.email is not null and t.email = lower(l.email)) or (t.pk is not null and t.pk = public.phone_key(l.phone))
                      or (t.nm is not null and t.nm = lower(trim(l.name))))
  ), w as (
    select bl.lead_id, count(*) reg,
      count(*) filter (where coalesce(bl.watch_minutes, 0) > 0 or bl.attended) att,
      coalesce(sum(bl.watch_minutes), 0) watch,
      max(bl.watch_minutes) best,
      (array_agg(bb.webinar_at order by bl.watch_minutes desc nulls last))[1] best_at,
      bool_or(coalesce(bl.saw_pitch, false)) pitch,
      coalesce(sum(bl.chat_count), 0) chats, coalesce(sum(bl.poll_answered), 0) polls
    from public.batch_leads bl join public.batches bb on bb.id = bl.batch_id
    where bl.lead_id in (select id from cand) group by bl.lead_id
  ), t as (
    select c.lead_id, sum(c.duration_sec) talk,
      jsonb_agg(jsonb_build_object('user', c.user_id, 'sec', c.s) order by c.s desc) filter (where c.s > 0) by_user
    from (select lead_id, user_id, sum(duration_sec) duration_sec, sum(duration_sec) s from public.calls
          where lead_id in (select id from cand) and direction in ('incoming','outgoing') and duration_sec > 0
          group by lead_id, user_id) c group by c.lead_id
  ), k as (
    select c.*, coalesce(w.reg, 0) reg, coalesce(w.att, 0) att, coalesce(w.watch, 0) watch, w.best, w.best_at,
      coalesce(w.pitch, false) pitch, coalesce(w.chats, 0) chats, coalesce(w.polls, 0) polls,
      coalesce(t.talk, 0) talk, t.by_user,
      (select max(x.started_at) from public.calls x where x.lead_id = c.id and x.duration_sec > 0) last_talk,
      case
        when c.intent = 'ready' then 1
        when c.intent = 'hot' then 2
        when c.intent = 'interested' or (c.ocat = 'positive' and c.ocode ~ 'interest') then 3
        when c.intent in ('approval','price','later') or c.ocat = 'positive' or c.ocode ~ 'call_back|call_later' then 4
        when coalesce(t.talk, 0) = 0 and coalesce(w.att, 0) >= 2 and (coalesce(w.chats, 0) + coalesce(w.polls, 0)) > 0 then 5
        when coalesce(t.talk, 0) = 0 and coalesce(w.att, 0) >= 2 then 6
        when coalesce(t.talk, 0) = 0 and coalesce(w.att, 0) = 1 and (coalesce(w.chats, 0) + coalesce(w.polls, 0)) > 0 then 7
        when coalesce(t.talk, 0) > 0 and coalesce(w.att, 0) > 0 then 8
      end cat
    from cand c left join w on w.lead_id = c.id left join t on t.lead_id = c.id
  ), hot as (select * from k where cat is not null)
  select jsonb_build_object(
    'total', (select count(*) from hot),
    'by_cat', coalesce((select jsonb_object_agg(cat, n) from (select cat, count(*) n from hot group by cat) z), '{}'),
    'by_owner', coalesce((select jsonb_agg(jsonb_build_object('owner', assigned_to, 'cat', cat, 'n', n)) from (select assigned_to, cat, count(*) n from hot group by 1, 2) z), '[]'),
    'list', coalesce((select jsonb_agg(jsonb_build_object(
      'lead_id', h.id, 'name', coalesce(nullif(h.name, ''), h.phone), 'phone', h.phone, 'owner', h.assigned_to, 'cat', h.cat,
      'tag', case h.intent when 'ready' then 'Ready to pay' when 'hot' then 'Hot' when 'interested' then 'Interested'
                when 'approval' then 'Needs approval' when 'price' then 'Price concern' when 'later' then 'Later' end,
      'outcome', case when h.ocat = 'positive' or h.ocode ~ 'call_back|call_later' then h.olabel end,
      'reg', greatest(h.reg, coalesce(h.reg_count, 0)), 'att', h.att, 'watch', round(h.watch), 'best', round(h.best), 'best_at', h.best_at,
      'pitch', h.pitch, 'chats', h.chats, 'polls', h.polls,
      'talk', h.talk, 'talk_by', coalesce(h.by_user, '[]'),
      'calls', coalesce(h.call_count, 0), 'wa', coalesce(h.wa_count, 0), 'last_talk', h.last_talk, 'next', h.next_follow_up_at)
      order by h.cat, h.watch desc, h.talk desc, (h.chats + h.polls + case when h.pitch then 1 else 0 end) desc, h.id)
    from (select * from hot order by cat, watch desc, talk desc, (chats + polls + case when pitch then 1 else 0 end) desc, id
          limit coalesce(p_limit, 5000)) h), '[]'))
$$;
revoke all on function public.hot_leads(uuid, uuid[], int) from public, anon, authenticated;
