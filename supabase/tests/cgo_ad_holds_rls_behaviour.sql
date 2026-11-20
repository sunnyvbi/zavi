begin;

insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-00000000ad01', 'ah-a', 'ah-a', 'test'),
  ('00000000-0000-0000-0000-00000000ad02', 'ah-b', 'ah-b', 'test');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner-a@ah.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner-b@ah.test');
insert into tenant_users (tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000ad01', '00000000-0000-0000-0000-0000000000b1', 'owner'),
  ('00000000-0000-0000-0000-00000000ad02', '00000000-0000-0000-0000-0000000000b2', 'owner');
insert into cgo_ad_holds (tenant_id, object_key, platform, object_id, name, from_usd, to_usd, reason) values
  ('00000000-0000-0000-0000-00000000ad01', 'meta:1', 'meta', '1', 'A ad set', 140, 168, 'you set it Oct 12'),
  ('00000000-0000-0000-0000-00000000ad02', 'meta:2', 'meta', '2', 'B ad set', 80, 96, 'test until Oct 28');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1"}', true);

do $$ begin
  if (select count(*) from cgo_ad_holds) <> 1 then
    raise exception 'member sees % hold rows, expected only their own company''s', (select count(*) from cgo_ad_holds);
  end if;
  if exists (select 1 from cgo_ad_holds where object_key = 'meta:2') then
    raise exception 'member can read another company''s holds';
  end if;
end $$;

do $$ begin
  begin
    insert into cgo_ad_holds (tenant_id, object_key, platform, object_id, reason)
      values ('00000000-0000-0000-0000-00000000ad01', 'meta:9', 'meta', '9', 'x');
    raise exception 'authenticated could insert a hold';
  exception when insufficient_privilege then null;
  end;
  begin
    update cgo_ad_holds set reason = 'y' where object_key = 'meta:1';
    raise exception 'authenticated could update a hold';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from cgo_ad_holds;
    raise exception 'anon could read holds';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
