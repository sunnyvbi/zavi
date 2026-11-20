
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ad-assets', 'ad-assets', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

commit;
