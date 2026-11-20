
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'launch-video-media',
  'launch-video-media',
  false,
  52428800,
  array['image/png', 'image/jpeg', 'image/webp', 'video/mp4']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists launch_video_media_deny_anon_select on storage.objects;
create policy launch_video_media_deny_anon_select on storage.objects
  for select to anon
  using (bucket_id = 'launch-video-media' and false);

drop policy if exists launch_video_media_deny_anon_insert on storage.objects;
create policy launch_video_media_deny_anon_insert on storage.objects
  for insert to anon
  with check (bucket_id = 'launch-video-media' and false);

drop policy if exists launch_video_media_deny_auth_select on storage.objects;
create policy launch_video_media_deny_auth_select on storage.objects
  for select to authenticated
  using (bucket_id = 'launch-video-media' and false);

drop policy if exists launch_video_media_deny_auth_insert on storage.objects;
create policy launch_video_media_deny_auth_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'launch-video-media' and false);

commit;
