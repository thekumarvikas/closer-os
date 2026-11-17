-- Round 15 · 3) Files on a rep's own WhatsApp messages.
-- Only managers could upload into template-media, so a rep saving "my message" with a photo or PDF failed.
-- Everyone may now keep files in their own folder: <org>/mine/<their user id>/<file>. Managers keep the rest.

drop policy if exists template_media_write_mine on storage.objects;
create policy template_media_write_mine on storage.objects for insert to authenticated
with check (
  bucket_id = 'template-media'
  and (storage.foldername(name))[2] = 'mine'
  and (storage.foldername(name))[3] = auth.uid()::text
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists template_media_delete_mine on storage.objects;
create policy template_media_delete_mine on storage.objects for delete to authenticated
using (
  bucket_id = 'template-media'
  and (storage.foldername(name))[2] = 'mine'
  and (storage.foldername(name))[3] = auth.uid()::text
);
