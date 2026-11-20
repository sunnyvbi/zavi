
alter table public.human_members
  add column if not exists photo_path text
    check (photo_path is null
           or (length(photo_path) between 3 and 400 and position('..' in photo_path) = 0));

alter table public.human_members
  add column if not exists illustration_path text
    check (illustration_path is null
           or (length(illustration_path) between 3 and 400 and position('..' in illustration_path) = 0));

alter table public.human_members
  add column if not exists illustration_generated_at timestamptz;

comment on column public.human_members.photo_path is
  'Creator profile photo, creator-media bucket key <auth_user_id>/<uuid>.<ext>. Served by signed URL only.';
comment on column public.human_members.illustration_path is
  'Zavi-generated niche illustration for a creator with no photo. Generated once. Served by signed URL only.';
comment on column public.human_members.illustration_generated_at is
  'When the one illustration generation was claimed. Non-null means never generate again automatically.';
