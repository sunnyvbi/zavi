
begin;

alter table bench_members
  add column if not exists bio text
    check (bio is null or length(btrim(bio)) between 1 and 2000);

comment on column bench_members.bio is
  'Free-text self-description from the signup form. Null for members who applied before the column existed.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bench-proof',
  'bench-proof',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

commit;
