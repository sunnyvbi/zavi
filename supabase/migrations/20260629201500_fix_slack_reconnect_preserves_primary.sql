
create or replace function set_slack_connection(
  p_tenant_id uuid,
  p_token text,
  p_team_id text,
  p_team_name text,
  p_scopes text[],
  p_bot_user_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_id uuid;
  v_new_id uuid;
  v_key text := 'slack.bot_token:' || p_team_id;
  v_existing_primary boolean;
  v_is_primary boolean;
begin
  select vault_secret_id into v_old_id from secrets
   where tenant_id = p_tenant_id and key = v_key;
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = v_key;
  end if;

  v_new_id := vault.create_secret(p_token);

  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, v_key, v_new_id);

  select is_primary into v_existing_primary
    from slack_workspaces
   where tenant_id = p_tenant_id and team_id = p_team_id;

  if v_existing_primary is not null then
    v_is_primary := v_existing_primary;
  else
    select not exists (
      select 1 from slack_workspaces
       where tenant_id = p_tenant_id and team_id <> p_team_id
    ) into v_is_primary;
  end if;

  if v_is_primary then
    update slack_workspaces
       set is_primary = false, updated_at = now()
     where tenant_id = p_tenant_id and is_primary and team_id <> p_team_id;
  end if;

  insert into slack_workspaces
    (tenant_id, team_id, team_name, bot_user_id, scopes, scopes_version,
     purpose, label, default_agent_slug, is_primary, connected_at)
  values
    (p_tenant_id, p_team_id, p_team_name, p_bot_user_id, p_scopes, 1,
     'general', p_team_name, null, v_is_primary, now())
  on conflict (tenant_id, team_id) do update
     set team_name      = excluded.team_name,
         bot_user_id    = excluded.bot_user_id,
         scopes         = excluded.scopes,
         scopes_version = slack_workspaces.scopes_version + 1,
         is_primary     = excluded.is_primary,
         connected_at   = excluded.connected_at,
         updated_at     = now();

  if v_is_primary then
    insert into connector_metadata
      (tenant_id, slug, team_id, team_name, scopes, bot_user_id, connected_at)
    values
      (p_tenant_id, 'slack', p_team_id, p_team_name, p_scopes, p_bot_user_id, now())
    on conflict (tenant_id, slug)
    do update set team_id      = excluded.team_id,
                  team_name    = excluded.team_name,
                  scopes       = excluded.scopes,
                  bot_user_id  = excluded.bot_user_id,
                  connected_at = excluded.connected_at;
  end if;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, 'slack', 'internal'::mcp_transport, null, null, null)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;
revoke all on function set_slack_connection(uuid, text, text, text, text[], text) from public;
