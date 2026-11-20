
begin;

alter table connector_metadata
  add column if not exists ad_accounts jsonb not null default '[]'::jsonb,
  add column if not exists selected_ad_account_id text,
  add column if not exists ad_accounts_for text,
  add column if not exists ad_accounts_checked_at timestamptz;

create or replace function set_connector_ad_accounts(
  p_tenant_id uuid,
  p_slug text,
  p_for text,
  p_accounts jsonb,
  p_selected text,
  p_prev_checked_at timestamptz
) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_at timestamptz;
begin
  if p_tenant_id is null or p_slug is null or p_for is null or p_accounts is null then
    raise exception 'set_connector_ad_accounts: tenant, slug, for and accounts are required';
  end if;
  if jsonb_typeof(p_accounts) <> 'array' then
    raise exception 'set_connector_ad_accounts: accounts must be an array';
  end if;
  if p_selected is not null and not exists (
    select 1 from jsonb_array_elements(p_accounts) a where a->>'advertiser_id' = p_selected
  ) then
    raise exception 'set_connector_ad_accounts: selected account is not in the list';
  end if;

  update connector_metadata
     set ad_accounts = p_accounts,
         selected_ad_account_id = p_selected,
         ad_accounts_for = p_for,
         ad_accounts_checked_at = clock_timestamp()
   where tenant_id = p_tenant_id
     and slug = p_slug
     and team_id = p_for
     and ad_accounts_checked_at is not distinct from p_prev_checked_at
  returning ad_accounts_checked_at into v_at;
  return v_at;
end $$;

revoke all on function set_connector_ad_accounts(uuid, text, text, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function set_connector_ad_accounts(uuid, text, text, jsonb, text, timestamptz) to service_role;

commit;
