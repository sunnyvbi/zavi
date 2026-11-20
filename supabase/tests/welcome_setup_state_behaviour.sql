begin;
insert into tenants (id, slug, display_name, kind) values ('00000000-0000-0000-0000-00000000bbbb', 'setup-test', 'setup-test', 'test');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@setup.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@setup.test');
insert into tenant_users (tenant_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-0000000000a2', 'member');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2"}', true);
do $$
declare k text;
begin
  foreach k in array array['setup_docs','setup_connectors','setup_done','setup_home'] loop
    begin
      perform mark_first_run_progress('00000000-0000-0000-0000-00000000bbbb', k, 'done');
      raise exception 'member was allowed %', k;
    exception when others then
      if sqlerrm <> 'owner or admin required' then raise; end if;
    end;
  end loop;
end $$;
select mark_first_run_progress('00000000-0000-0000-0000-00000000bbbb', 'plan_opened', 'plan');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1"}', true);
select mark_first_run_progress('00000000-0000-0000-0000-00000000bbbb', 'setup_docs', 'skipped');
select mark_first_run_progress('00000000-0000-0000-0000-00000000bbbb', 'setup_docs', 'done');
reset role;
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if auth.uid() is not null then raise exception 'claims not cleared: auth.uid() = %', auth.uid(); end if;
  if not exists (
    select 1 from tenant_first_run_progress
     where tenant_id = '00000000-0000-0000-0000-00000000bbbb'
       and setup_docs_at is not null and setup_docs_skipped = true
       and setup_connectors_at is null and setup_done_at is null
  ) then
    raise exception 'expected docs=skipped (first answer kept) and nothing else set';
  end if;
end $$;
rollback;
