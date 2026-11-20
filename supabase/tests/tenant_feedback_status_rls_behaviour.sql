begin;

insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-00000000fb01', 'fb-a', 'fb-a', 'test'),
  ('00000000-0000-0000-0000-00000000fb02', 'fb-b', 'fb-b', 'test');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'maya@fb.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'teammate@fb.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'outsider@fb.test');
insert into tenant_users (tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000000a1', 'viewer'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000000a2', 'owner'),
  ('00000000-0000-0000-0000-00000000fb02', '00000000-0000-0000-0000-0000000000a3', 'owner');
insert into tenant_feedback (id, tenant_id, created_by, body, status, status_updated_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000000a1', 'mine', 'done', now()),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000000a2', 'teammate''s', 'working', now()),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-00000000fb02', '00000000-0000-0000-0000-0000000000a3', 'other company', 'done', now());

do $$ begin
  if (select status from tenant_feedback where id = '00000000-0000-0000-0000-0000000000f1') <> 'done' then
    raise exception 'status column missing';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1"}', true);

do $$ begin
  if (select count(*) from tenant_feedback) <> 1 then
    raise exception 'member sees % rows, expected only their own', (select count(*) from tenant_feedback);
  end if;
  if exists (select 1 from tenant_feedback where id = '00000000-0000-0000-0000-0000000000f2') then
    raise exception 'member can read a teammate''s feedback';
  end if;
end $$;

do $$ begin
  begin
    update tenant_feedback set status = 'received' where id = '00000000-0000-0000-0000-0000000000f1';
    raise exception 'direct update allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

select mark_my_tenant_feedback_seen('00000000-0000-0000-0000-00000000fb01');
do $$ begin
  begin
    perform mark_my_tenant_feedback_seen('00000000-0000-0000-0000-00000000fb02');
    raise exception 'seen marker accepted a foreign company';
  exception when raise_exception then
    if sqlerrm <> 'unauthorized' then raise; end if;
  end;
end $$;

reset role;
select set_config('request.jwt.claims', '{}', true);

do $$ begin
  if (select sender_seen_at from tenant_feedback where id = '00000000-0000-0000-0000-0000000000f1') is null then
    raise exception 'own row not marked seen';
  end if;
  if (select sender_seen_at from tenant_feedback where id = '00000000-0000-0000-0000-0000000000f2') is not null then
    raise exception 'teammate''s row marked seen';
  end if;
  if (select sender_seen_at from tenant_feedback where id = '00000000-0000-0000-0000-0000000000f3') is not null then
    raise exception 'other company''s row marked seen';
  end if;
end $$;

rollback;
