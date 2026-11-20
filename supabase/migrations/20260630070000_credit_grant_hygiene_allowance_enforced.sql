
revoke all on function _credit_allowance_for_tenant(uuid) from public, anon, authenticated;
revoke all on function _credits_enforced()                from public, anon, authenticated;
revoke all on function _credits_enforced(uuid)            from public, anon, authenticated;

grant execute on function _credit_allowance_for_tenant(uuid) to service_role;
grant execute on function _credits_enforced()                to service_role;
grant execute on function _credits_enforced(uuid)            to service_role;

do $$
begin
  raise notice '20260630070000: revoked client EXECUTE on credit read helpers (_credit_allowance_for_tenant, _credits_enforced/0, _credits_enforced/1)';
end $$;
