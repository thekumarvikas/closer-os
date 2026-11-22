-- Message template upgrades (owner, Nov 23 2026): tags + search, messages offered after the right outcome,
-- a joining link per webinar ({{joinLink}}), and a report of which messages lead to sales.
alter table public.message_templates add column if not exists tags text[] not null default '{}';
-- Outcome categories (positive, connected, not_connected, lost, won, invalid) or outcome ids; empty = after any call.
alter table public.message_templates add column if not exists show_for text[] not null default '{}';
alter table public.batches add column if not exists join_link text;

-- How each message is doing: times sent, leads, who sent, and leads who bought within 7 days after getting it.
create or replace function public.template_report(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with s as (
    select w.id, w.template_id, coalesce(t.name, w.template_name, 'Typed by hand') as name, w.lead_id, w.user_id, w.sent_at
    from public.wa_messages w left join public.message_templates t on t.id = w.template_id
    where w.org_id = p_org and w.sent_at >= p_from and w.sent_at < p_to and w.undone_at is null
      and public.is_org_member(p_org) and (w.user_id = auth.uid() or public.can_see_user(p_org, w.user_id))
  ), b as (
    select s.*, exists (select 1 from public.sales x where x.lead_id = s.lead_id and x.status = 'verified'
                          and x.sold_at >= s.sent_at and x.sold_at < s.sent_at + interval '7 days') as bought
    from s
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(r order by (r->>'sent')::int desc) from (
      select jsonb_build_object('template_id', template_id, 'name', name, 'sent', count(*), 'leads', count(distinct lead_id),
        'senders', count(distinct user_id),
        'bought', count(distinct lead_id) filter (where bought),
        'by_user', (select jsonb_object_agg(u, c) from (select b2.user_id::text u, count(*) c from b b2
                     where b2.name = b.name and b2.template_id is not distinct from b.template_id group by 1) z)) r
      from b group by template_id, name) q), '[]'::jsonb),
    'total', (select count(*) from s))
$$;
revoke all on function public.template_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.template_report(uuid, timestamptz, timestamptz) to authenticated;
