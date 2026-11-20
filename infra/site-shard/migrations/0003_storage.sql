
begin;

create or replace function zsite.file_path_site(p_name text) returns uuid
language sql immutable security invoker set search_path = '' as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-z][a-z0-9_]{0,62}/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

create or replace function zsite.file_permits(p_name text, p_op text, p_owner text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select zsite.principal_match(c.rules->p_op,
                                 case when zsite.is_uuid(p_owner) then p_owner::uuid end)
    from zsite.collections c
    where c.site_id = zsite.request_site()
      and c.site_id = zsite.file_path_site(p_name)
      and c.name = split_part(p_name, '/', 2)
      and c.kind = 'files'
  ), false)
$$;

revoke all on function zsite.file_path_site(text), zsite.file_permits(text, text, text) from public;
grant execute on function zsite.file_path_site(text), zsite.file_permits(text, text, text)
  to anon, authenticated, service_role;

insert into storage.buckets (id, name, public) values ('site-files', 'site-files', false)
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    execute 'update storage.buckets set file_size_limit = 10485760 where id = ''site-files''';
  end if;
end $$;

drop policy if exists zsite_files_site on storage.objects;
create policy zsite_files_site on storage.objects as restrictive for all to anon, authenticated
  using (bucket_id <> 'site-files' or zsite.file_path_site(name) = (select zsite.request_site()))
  with check (bucket_id <> 'site-files' or zsite.file_path_site(name) = (select zsite.request_site()));

drop policy if exists zsite_files_read on storage.objects;
create policy zsite_files_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'site-files'
         and (zsite.file_permits(name, 'get', owner_id) or zsite.file_permits(name, 'list', owner_id)));

drop policy if exists zsite_files_create on storage.objects;
create policy zsite_files_create on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'site-files'
              and zsite.file_permits(name, 'create', owner_id)
              and owner_id is not distinct from (select m.user_id::text from zsite.request_member() m));

drop policy if exists zsite_files_update on storage.objects;
create policy zsite_files_update on storage.objects for update to authenticated
  using (bucket_id = 'site-files' and zsite.file_permits(name, 'update', owner_id))
  with check (bucket_id = 'site-files' and zsite.file_permits(name, 'update', owner_id));

drop policy if exists zsite_files_delete on storage.objects;
create policy zsite_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'site-files' and zsite.file_permits(name, 'delete', owner_id));

insert into zsite.migrations (version) values ('0003_storage') on conflict do nothing;

commit;
