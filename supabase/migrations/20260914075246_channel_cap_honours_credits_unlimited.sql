
begin;

create or replace function channel_budget_allows(p_tenant_id uuid, p_estimate int)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select _credits_unlimited(p_tenant_id)
      or (channel_credits_30d(p_tenant_id) + greatest(coalesce(p_estimate, 0), 0))
         <= channel_credit_cap();
$$;

revoke all on function channel_budget_allows(uuid, int) from public, anon, authenticated;
grant execute on function channel_budget_allows(uuid, int) to service_role;

commit;

do $$
begin
  raise notice '20260914075246: channel_budget_allows now honours tenants.credits_unlimited (metered + auditable, never blocked)';
end $$;
