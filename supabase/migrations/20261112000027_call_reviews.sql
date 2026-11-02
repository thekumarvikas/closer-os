-- Call reviews (auditing + coaching): a manager scores a call on the company's checklist (1–5 per
-- item), writes what went well / what to improve, and can set a coaching task. Reps see their reviews.
-- Checklist lives in organizations.settings.review_criteria (list of labels).
update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('review_criteria', jsonb_build_array(
  'Opening & rapport', 'Understanding the need', 'Explaining the offer', 'Handling objections', 'Closing / next step', 'Tone & confidence'))
where not (coalesce(settings, '{}'::jsonb) ? 'review_criteria');

create table if not exists public.call_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  call_id uuid not null references public.calls(id) on delete cascade,
  rep_id uuid not null references auth.users(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  scores jsonb not null default '{}'::jsonb,      -- {"Opening & rapport": 4, ...}
  score_pct int,                                  -- average as % of 5
  went_well text,
  improve text,
  task text,                                      -- coaching task for the rep
  task_due date,
  task_done_at timestamptz,
  seen_at timestamptz,                            -- rep opened it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_id)
);
create index if not exists call_reviews_rep_idx on public.call_reviews (org_id, rep_id, created_at desc);
alter table public.call_reviews enable row level security;
drop policy if exists call_reviews_read on public.call_reviews;
create policy call_reviews_read on public.call_reviews for select using (
  rep_id = auth.uid() or (public.is_org_manager(org_id) and public.can_see_user(org_id, rep_id)));

create or replace function public.save_call_review(p_call uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.calls; v_id uuid; v_pct int;
begin
  select * into c from public.calls where id = p_call;
  if c.id is null or not public.is_org_manager(c.org_id) or not public.can_see_user(c.org_id, c.user_id) then raise exception 'Not allowed'; end if;
  if c.user_id = auth.uid() then raise exception 'You can''t review your own call'; end if;
  select round(avg(v::numeric) * 20)::int into v_pct from jsonb_each_text(coalesce(p->'scores', '{}')) as e(k, v) where v ~ '^[1-5]$';
  insert into public.call_reviews (org_id, call_id, rep_id, reviewer_id, scores, score_pct, went_well, improve, task, task_due)
  values (c.org_id, c.id, c.user_id, auth.uid(), coalesce(p->'scores', '{}'), v_pct, nullif(trim(p->>'went_well'), ''), nullif(trim(p->>'improve'), ''),
          nullif(trim(p->>'task'), ''), nullif(p->>'task_due', '')::date)
  on conflict (call_id) do update set reviewer_id = auth.uid(), scores = excluded.scores, score_pct = excluded.score_pct,
    went_well = excluded.went_well, improve = excluded.improve, task = excluded.task, task_due = excluded.task_due,
    seen_at = null, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Calls waiting for review: answered calls of visible reps, recorded first, not yet reviewed.
create or replace function public.calls_to_review(p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null,
  p_min_sec int default 60, p_recorded_only boolean default true)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  if p_users is not null and cardinality(p_users) > 0 then v_users := array(select unnest(v_users) intersect select unnest(p_users)); end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into res from (
    select jsonb_build_object('id', c.id, 'user_id', c.user_id, 'started_at', c.started_at, 'duration_sec', c.duration_sec, 'direction', c.direction,
      'phone', c.phone, 'lead_name', l.name, 'outcome_id', c.outcome_id, 'notes', c.notes, 'purpose', c.purpose,
      'recording_status', c.recording_status, 'recording_path', c.recording_path) as x
    from public.calls c left join public.leads l on l.id = c.lead_id
    where c.org_id = p_org and c.user_id = any(v_users) and c.user_id <> auth.uid()
      and c.started_at >= p_from and c.started_at < p_to and c.duration_sec >= p_min_sec
      and (not p_recorded_only or c.recording_status = 'uploaded')
      and not exists (select 1 from public.call_reviews r where r.call_id = c.id)
    order by (c.recording_status = 'uploaded') desc, c.started_at desc limit 200) t;
  return res;
end $$;

-- Reviews with call details (dashboard list + app "My feedback").
create or replace function public.review_list(p_org uuid, p_users uuid[] default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into res from (
    select jsonb_build_object('id', r.id, 'call_id', r.call_id, 'rep_id', r.rep_id, 'reviewer_id', r.reviewer_id, 'reviewer', p.full_name,
      'scores', r.scores, 'score_pct', r.score_pct, 'went_well', r.went_well, 'improve', r.improve, 'task', r.task, 'task_due', r.task_due,
      'task_done_at', r.task_done_at, 'seen_at', r.seen_at, 'created_at', r.created_at,
      'started_at', c.started_at, 'duration_sec', c.duration_sec, 'lead_name', l.name, 'phone', c.phone,
      'recording_status', c.recording_status, 'recording_path', c.recording_path) as x
    from public.call_reviews r join public.calls c on c.id = r.call_id left join public.leads l on l.id = c.lead_id
    left join public.profiles p on p.id = r.reviewer_id
    where r.org_id = p_org and (r.rep_id = auth.uid() or (public.is_org_manager(p_org) and public.can_see_user(p_org, r.rep_id)))
      and (p_users is null or cardinality(p_users) = 0 or r.rep_id = any(p_users))
    order by r.created_at desc limit p_limit) t;
  return res;
end $$;

-- Rep: open a review (seen) / finish the coaching task.
create or replace function public.mark_review(p_id uuid, p_task_done boolean default false)
returns void language sql security definer set search_path = '' as $$
  update public.call_reviews set seen_at = coalesce(seen_at, now()),
    task_done_at = case when p_task_done then coalesce(task_done_at, now()) else task_done_at end
  where id = p_id and rep_id = auth.uid()
$$;

-- Team scores: average per rep and per checklist item for a period.
create or replace function public.review_scores(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_users uuid[]; res jsonb;
begin
  if not public.is_org_manager(p_org) then raise exception 'Not allowed'; end if;
  v_users := public.visible_user_ids(p_org);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into res from (
    select jsonb_build_object('rep_id', r.rep_id, 'reviews', count(*), 'avg_pct', round(avg(r.score_pct)),
      'tasks_open', count(*) filter (where r.task is not null and r.task_done_at is null),
      'by_item', (select coalesce(jsonb_object_agg(k, a), '{}'::jsonb) from (
          select e.k, round(avg(e.v::numeric), 1) a from public.call_reviews r2, jsonb_each_text(r2.scores) e(k, v)
          where r2.rep_id = r.rep_id and r2.org_id = p_org and r2.created_at >= p_from and r2.created_at < p_to and e.v ~ '^[1-5]$' group by e.k) s)) as x
    from public.call_reviews r
    where r.org_id = p_org and r.rep_id = any(v_users) and r.created_at >= p_from and r.created_at < p_to
    group by r.rep_id) t;
  return res;
end $$;

do $$ declare f text; begin
  foreach f in array array['save_call_review(uuid, jsonb)', 'calls_to_review(uuid, timestamptz, timestamptz, uuid[], int, boolean)',
    'review_list(uuid, uuid[], int)', 'mark_review(uuid, boolean)', 'review_scores(uuid, timestamptz, timestamptz)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
