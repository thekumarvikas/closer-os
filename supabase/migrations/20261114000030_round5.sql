-- Owner feedback round 5: lead filters in the app, older notes as proper notes, media on WhatsApp messages.

-- ───────────── Lead filters for the app ─────────────
-- Which filters show in the app's Leads tab: organizations.settings.app_lead_filters (list of keys:
-- followup, stage, outcome, source, campaign, city, category, never_called, custom.<field>). Null = defaults.
create or replace function public.lead_filter_options(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_mine boolean; res jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'Not allowed'; end if;
  v_mine := public.org_role(p_org) = 'rep';
  with l as (
    select * from public.leads where org_id = p_org and deleted_at is null and (not v_mine or assigned_to = auth.uid())
  ), custom_keys as (
    select k, count(*) n from l, jsonb_object_keys(coalesce(l.custom, '{}'::jsonb)) k group by k order by n desc limit 15
  )
  select jsonb_build_object(
    'enabled', (select settings->'app_lead_filters' from public.organizations where id = p_org),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position), '[]') from public.pipeline_stages where org_id = p_org and is_active),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position), '[]') from public.profession_categories where org_id = p_org),
    'sources', (select coalesce(jsonb_agg(v order by n desc), '[]') from (select source v, count(*) n from l where coalesce(source, '') <> '' group by 1 order by 2 desc limit 30) s),
    'campaigns', (select coalesce(jsonb_agg(v order by n desc), '[]') from (select campaign v, count(*) n from l where coalesce(campaign, '') <> '' group by 1 order by 2 desc limit 30) s),
    'cities', (select coalesce(jsonb_agg(v order by n desc), '[]') from (select initcap(trim(city)) v, count(*) n from l where coalesce(city, '') <> '' group by 1 order by 2 desc limit 40) s),
    'custom', (select coalesce(jsonb_agg(jsonb_build_object('key', ck.k,
        'label', coalesce((select label from public.custom_fields cf where cf.org_id = p_org and cf.key = ck.k), initcap(replace(ck.k, '_', ' '))),
        'values', (select coalesce(jsonb_agg(v order by n desc), '[]') from (
          select l.custom->>ck.k v, count(*) n from l where coalesce(l.custom->>ck.k, '') <> '' and length(l.custom->>ck.k) <= 40
          group by 1 order by 2 desc limit 25) s))), '[]') from custom_keys ck)
  ) into res;
  return res;
end $$;
revoke execute on function public.lead_filter_options(uuid) from anon, public;
grant execute on function public.lead_filter_options(uuid) to authenticated;

-- ───────────── Older dashboard notes → separate notes ─────────────
-- The dashboard used to add notes into the lead's notes text as "dd/mm hh:mm: text" lines.
-- Each such line becomes a proper note (shown in the notes history); other text stays as "notes from the import".
do $$
declare r record; line text; keep text[]; m text[];
begin
  for r in select id, org_id, notes, created_at from public.leads where notes ~ '(^|\n)\d\d/\d\d \d\d:\d\d: ' loop
    keep := '{}';
    foreach line in array string_to_array(r.notes, E'\n') loop
      m := regexp_match(line, '^(\d\d)/(\d\d) (\d\d):(\d\d): (.*)$');
      if m is null then keep := keep || line;
      else
        insert into public.lead_activities (org_id, lead_id, kind, data, created_at)
        values (r.org_id, r.id, 'note', jsonb_build_object('text', m[5], 'tags', '[]'::jsonb),
          coalesce((make_timestamp(extract(year from r.created_at)::int, m[2]::int, m[1]::int, m[3]::int, m[4]::int, 0) at time zone 'Asia/Kolkata'), r.created_at));
      end if;
    end loop;
    update public.leads set notes = nullif(trim(array_to_string(keep, E'\n')), '') where id = r.id;
  end loop;
end $$;

-- ───────────── Photos / videos / PDFs on WhatsApp messages ─────────────
alter table public.message_templates add column if not exists media_path text;
alter table public.message_templates add column if not exists media_type text;
alter table public.message_templates add column if not exists media_name text;

insert into storage.buckets (id, name, public, file_size_limit)
values ('template-media', 'template-media', false, 16777216) on conflict (id) do nothing;
-- Files live at <org>/<file>. Members read their company's files; managers upload/delete.
drop policy if exists template_media_read on storage.objects;
create policy template_media_read on storage.objects for select to authenticated
  using (bucket_id = 'template-media' and public.is_org_member(((storage.foldername(name))[1])::uuid));
drop policy if exists template_media_write on storage.objects;
create policy template_media_write on storage.objects for insert to authenticated
  with check (bucket_id = 'template-media' and public.is_org_manager(((storage.foldername(name))[1])::uuid));
drop policy if exists template_media_delete on storage.objects;
create policy template_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'template-media' and public.is_org_manager(((storage.foldername(name))[1])::uuid));
