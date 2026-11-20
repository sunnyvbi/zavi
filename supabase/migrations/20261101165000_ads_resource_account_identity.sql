begin;
alter table ads_conversion_sources add column account_id uuid references ads_provider_accounts(id);
alter table ads_resource_bindings add column account_id uuid references ads_provider_accounts(id);
do $$
declare legacy uuid; t record; fk record;
begin
 select id into strict legacy from ads_provider_accounts where legacy_key='chatgpt_platform';
 execute format('alter table ads_conversion_sources alter column account_id set default %L::uuid',legacy);
 execute format('alter table ads_resource_bindings alter column account_id set default %L::uuid',legacy);
 update ads_conversion_sources set account_id=legacy;
 update ads_resource_bindings set account_id=legacy;
 for t in select tenant_id from ads_conversion_sources union select tenant_id from ads_resource_bindings loop
  perform ads_legacy_account_binding(t.tenant_id);
 end loop;
 for fk in select conname from pg_constraint where conrelid='ads_resource_bindings'::regclass and confrelid='ads_conversion_sources'::regclass loop
  execute format('alter table ads_resource_bindings drop constraint %I',fk.conname);
 end loop;
end $$;
alter table ads_conversion_sources alter column account_id set not null;
alter table ads_resource_bindings alter column account_id set not null;
alter table ads_conversion_sources drop constraint ads_conversion_sources_pkey, drop constraint ads_conversion_sources_source_id_tenant_id_key;
alter table ads_conversion_sources add primary key(account_id,source_id), add unique(account_id,source_id,tenant_id);
alter table ads_resource_bindings drop constraint ads_resource_bindings_pkey;
alter table ads_resource_bindings add primary key(account_id,resource_id),
 add foreign key(account_id,source_id,tenant_id) references ads_conversion_sources(account_id,source_id,tenant_id) on delete cascade;
create function ads_resource_account_owner() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from ads_provider_accounts a where a.id=new.account_id and a.platform='chatgpt'
  and (a.legacy_key='chatgpt_platform' or exists(select 1 from ads_account_bindings b where b.account_id=a.id and b.tenant_id=new.tenant_id))) then
  raise exception 'resource account ownership mismatch';
 end if;
 return new;
end $$;
create trigger ads_resource_account_owner before insert or update on ads_resource_bindings for each row execute function ads_resource_account_owner();
create trigger ads_source_account_owner before insert or update on ads_conversion_sources for each row execute function ads_resource_account_owner();
revoke all on function ads_resource_account_owner() from public,anon,authenticated;
create view ads_resource_binding_details as select r.*,a.legacy_key from ads_resource_bindings r join ads_provider_accounts a on a.id=r.account_id;
revoke all on ads_resource_binding_details from public,anon,authenticated;
grant select on ads_resource_binding_details to service_role;
commit;
