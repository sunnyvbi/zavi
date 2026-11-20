
drop policy if exists "connector_metadata_active_tenant_restrict" on public.connector_metadata;
create policy "connector_metadata_active_tenant_restrict"
  on public.connector_metadata
  as restrictive
  for select
  using (
    tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid
  );
