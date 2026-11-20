
begin;

alter table tenants
  add column if not exists kind text not null default 'real'
  check (kind in ('real', 'test'));

comment on column tenants.kind is
  'Deletion class. default ''real'' (protected). ''test'' = QA/build/benchmark throwaway, eligible for cleanup. A BEFORE DELETE guard (tenants_delete_guard) blocks deleting any non-test tenant.';

create or replace function tenant_delete_guard()
returns trigger language plpgsql as $$
begin
  if old.kind is distinct from 'test' then
    raise exception
      'tenant % (kind=%) is protected: only kind=''test'' tenants may be deleted. To remove a real tenant, first run UPDATE tenants SET kind=''test'' WHERE id=''%'' deliberately, then delete.',
      old.slug, coalesce(old.kind, 'real'), old.id
      using errcode = '42501';
  end if;
  return old;
end $$;

drop trigger if exists tenants_delete_guard on tenants;
create trigger tenants_delete_guard
  before delete on tenants
  for each row execute function tenant_delete_guard();

commit;
