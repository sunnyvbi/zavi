begin;
insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-00000000dddd', 'rls-test', 'rls-test', 'test'),
  ('00000000-0000-0000-0000-00000000eeee', 'rls-foreign', 'rls-foreign', 'test');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner@rls.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'member@rls.test');
insert into tenant_users (tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000dddd', '00000000-0000-0000-0000-0000000000b1', 'owner'),
  ('00000000-0000-0000-0000-00000000dddd', '00000000-0000-0000-0000-0000000000b2', 'member');
insert into tenant_document (id, tenant_id, filename, storage_path, status) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000dddd', 'ok.md',      '00000000-0000-0000-0000-00000000dddd/f1/1/ok.md', 'approved'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000dddd', 'secret.md',  '00000000-0000-0000-0000-00000000dddd/f2/1/secret.md', 'imported'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-00000000eeee', 'foreign.md', '00000000-0000-0000-0000-00000000eeee/f3/1/foreign.md', 'approved'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-00000000eeee', 'foreign-imp.md', '00000000-0000-0000-0000-00000000eeee/f4/1/foreign-imp.md', 'imported');
insert into storage.objects (bucket_id, name) values
  ('tenant-documents', '00000000-0000-0000-0000-00000000dddd/f1/1/ok.md'),
  ('tenant-documents', '00000000-0000-0000-0000-00000000dddd/f2/1/secret.md'),
  ('tenant-documents', '00000000-0000-0000-0000-00000000dddd/orphan/1/raw.md'),
  ('tenant-documents', '00000000-0000-0000-0000-00000000eeee/f3/1/foreign.md'),
  ('tenant-documents', '00000000-0000-0000-0000-00000000eeee/f4/1/foreign-imp.md');

set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2"}', true);
do $$ begin
  if (select array_agg(filename order by filename) from tenant_document) is distinct from array['ok.md'] then
    raise exception 'member rows: expected {ok.md}, got %', (select array_agg(filename order by filename) from tenant_document);
  end if;
  if (select array_agg(name order by name) from storage.objects where bucket_id = 'tenant-documents')
     is distinct from array['00000000-0000-0000-0000-00000000dddd/f1/1/ok.md'] then
    raise exception 'member objects: expected only ok.md, got %',
      (select array_agg(name order by name) from storage.objects where bucket_id = 'tenant-documents');
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1"}', true);
do $$ begin
  if (select array_agg(filename order by filename) from tenant_document) is distinct from array['ok.md', 'secret.md'] then
    raise exception 'owner rows: expected {ok.md,secret.md}, got %', (select array_agg(filename order by filename) from tenant_document);
  end if;
  if (select count(*) from storage.objects where bucket_id = 'tenant-documents') <> 3 then
    raise exception 'owner objects: expected 3, got %', (select count(*) from storage.objects where bucket_id = 'tenant-documents');
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'tenant-documents' and name like '00000000-0000-0000-0000-00000000eeee/%') then
    raise exception 'owner sees a FOREIGN tenant object';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if auth.uid() is not null then raise exception 'claims not cleared'; end if;
end $$;
rollback;
