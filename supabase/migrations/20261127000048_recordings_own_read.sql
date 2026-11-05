-- Uploads use "upsert", which storage only allows when the uploader may also READ the file.
-- The old read rule needed calls.recording_path to point at the file first (set only AFTER the upload),
-- so every upload was refused with "new row violates row-level security policy".
-- A rep may read their own folder (<org>/<their user id>/…); managers still read via the call.
drop policy if exists recordings_select_own on storage.objects;
create policy recordings_select_own on storage.objects for select using (
  bucket_id = 'recordings' and (storage.foldername(name))[2] = (auth.uid())::text
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);
