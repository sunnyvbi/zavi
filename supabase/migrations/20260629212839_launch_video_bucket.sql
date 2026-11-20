
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'launch-video-artifacts',
  'launch-video-artifacts',
  false,
  209715200,
  array['video/mp4']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists launch_video_deny_anon_select on storage.objects;
create policy launch_video_deny_anon_select on storage.objects
  for select to anon
  using (bucket_id = 'launch-video-artifacts' and false);

drop policy if exists launch_video_deny_anon_insert on storage.objects;
create policy launch_video_deny_anon_insert on storage.objects
  for insert to anon
  with check (bucket_id = 'launch-video-artifacts' and false);

drop policy if exists launch_video_deny_authenticated_select on storage.objects;
create policy launch_video_deny_authenticated_select on storage.objects
  for select to authenticated
  using (bucket_id = 'launch-video-artifacts' and false);

drop policy if exists launch_video_deny_authenticated_insert on storage.objects;
create policy launch_video_deny_authenticated_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'launch-video-artifacts' and false);

alter table public.run_artifacts
  add column if not exists bucket text not null default 'agent-artifacts';

commit;
