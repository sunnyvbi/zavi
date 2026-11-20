
alter table creator_library_assets
  add column if not exists youtube_video_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.creator_library_assets'::regclass
       and conname = 'creator_library_assets_youtube_video_id_check'
  ) then
    alter table creator_library_assets
      add constraint creator_library_assets_youtube_video_id_check
      check (youtube_video_id is null or youtube_video_id ~ '^[A-Za-z0-9_-]{11}$');
  end if;
end $$;

comment on column creator_library_assets.youtube_video_id is
  'The 11-character YouTube video id for this creator video, on the BUSINESS''s own channel. Pasted by a human (bare id or watch/shorts/embed URL, canonicalised server-side); Zavi never uploads to YouTube. Must be set before Zavi will propose a PAUSED Google Ads video ad for this asset.';
