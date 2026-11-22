-- One person = one lead, all contacts kept (Nov 22): every number / email a lead arrived with earlier (lead_origins) is
-- kept on the lead as Secondary, for every client. (Two Zoom attendee files of one client were also applied once by hand.)
-- (2) Every client: numbers / emails a lead arrived with before (registrations, imports, webhooks) that aren't on it
insert into lead_phones (org_id, lead_id, phone, label, source)
select distinct on (l.id, public.phone_key(o.data->>'phone')) l.org_id, l.id, o.data->>'phone', 'Secondary', coalesce(o.kind, 'arrival')
from lead_origins o join leads l on l.id = o.lead_id and l.deleted_at is null
where length(public.phone_key(o.data->>'phone')) >= 8 and l.phone_key is distinct from public.phone_key(o.data->>'phone')
  and not exists (select 1 from lead_phones p where p.lead_id = l.id and public.phone_key(p.phone) = public.phone_key(o.data->>'phone'))
on conflict do nothing;
insert into lead_emails (org_id, lead_id, email, email_key, label, source)
select distinct on (l.id, public.email_key(o.data->>'email')) l.org_id, l.id, public.clean_email(o.data->>'email'), public.email_key(o.data->>'email'), 'Secondary', coalesce(o.kind, 'arrival')
from lead_origins o join leads l on l.id = o.lead_id and l.deleted_at is null
where position('@' in coalesce(public.email_key(o.data->>'email'),'')) > 1 and l.email_key is distinct from public.email_key(o.data->>'email')
  and not exists (select 1 from lead_emails e where e.lead_id = l.id and e.email_key = public.email_key(o.data->>'email'))
on conflict do nothing;
