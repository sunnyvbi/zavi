
begin;

create or replace function account_purge_link_columns()
returns table (rel text, col text, kind text)
language sql immutable set search_path = public, pg_temp as $$
  values
    ('ads_provider_accounts'::text, 'credential_tenant_id'::text, 'owner'::text),
    ('profiles', 'active_tenant_id', 'foreign'),
    ('shopify_pending_installations', 'claimed_tenant_id', 'owner')
$$;

commit;
