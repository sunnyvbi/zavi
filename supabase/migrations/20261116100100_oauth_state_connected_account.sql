alter table public.oauth_states
  add column if not exists connected_account_id text;

create or replace function public.bind_oauth_state_account(
  p_provider text,
  p_state_hash text,
  p_connected_account_id text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(length(p_connected_account_id), 0) = 0 then
    return false;
  end if;
  update public.oauth_states
  set connected_account_id = p_connected_account_id
  where state_hash = p_state_hash
    and provider = p_provider
    and expires_at > now()
    and connected_account_id is null;
  return found;
end $$;

create or replace function public.consume_oauth_state_bound(
  p_provider text,
  p_state_hash text
) returns table (tenant_id uuid, user_id uuid, connected_account_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  delete from public.oauth_states s
  where s.state_hash = p_state_hash
    and s.provider = p_provider
    and s.expires_at > now()
  returning s.tenant_id, s.user_id, s.connected_account_id;
end $$;

revoke all on function public.bind_oauth_state_account(text, text, text) from public, anon, authenticated;
revoke all on function public.consume_oauth_state_bound(text, text) from public, anon, authenticated;
grant execute on function public.bind_oauth_state_account(text, text, text) to service_role;
grant execute on function public.consume_oauth_state_bound(text, text) to service_role;

create or replace function public.delete_platform_secret(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_id uuid;
begin
  delete from public.platform_secrets ps
  where ps.key = p_key
  returning ps.vault_secret_id into v_id;
  if v_id is null then return false; end if;
  delete from vault.secrets vs where vs.id = v_id;
  return true;
end $$;

revoke all on function public.delete_platform_secret(text) from public, anon, authenticated;
grant execute on function public.delete_platform_secret(text) to service_role;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('composio.shopify_write', 'Change a connected Shopify store (a product update or a new discount code). Owner or admin approval, never automatic.', 'approval', 'composio.execute_tool', true, false, 'high')
on conflict (slug) do update
  set never_auto = true,
      default_autonomy = 'approval',
      dispatch_handler = 'composio.execute_tool';
