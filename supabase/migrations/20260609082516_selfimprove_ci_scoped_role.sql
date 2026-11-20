
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'self_improve_ci') then
    create role self_improve_ci nologin noinherit;
  end if;
end $$;

grant self_improve_ci to authenticator;

grant usage on schema public to self_improve_ci;

grant execute on function list_pending_improvement_requests(int)        to self_improve_ci;
grant execute on function finalize_improvement_request(bigint, text)    to self_improve_ci;
grant execute on function reap_stale_improvement_leases(int)            to self_improve_ci;
