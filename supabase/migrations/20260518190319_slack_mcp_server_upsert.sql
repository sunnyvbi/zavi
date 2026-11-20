

create or replace function set_slack_connection(
  p_tenant_id uuid,
  p_token text,
  p_team_id text,
  p_team_name text,
  p_scopes text[],
  p_bot_user_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_old_id uuid; v_new_id uuid;
begin
  select vault_secret_id into v_old_id from secrets
  where tenant_id = p_tenant_id and key = 'slack.bot_token';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'slack.bot_token';
  end if;

  v_new_id := vault.create_secret(p_token);

  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'slack.bot_token', v_new_id);

  insert into connector_metadata
    (tenant_id, slug, team_id, team_name, scopes, bot_user_id, connected_at)
  values
    (p_tenant_id, 'slack', p_team_id, p_team_name, p_scopes, p_bot_user_id, now())
  on conflict (tenant_id, slug)
  do update set team_id     = excluded.team_id,
                team_name   = excluded.team_name,
                scopes      = excluded.scopes,
                bot_user_id = excluded.bot_user_id,
                connected_at = excluded.connected_at;

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

insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
select cm.tenant_id, 'slack', 'internal'::mcp_transport, null, null, null
from connector_metadata cm
where cm.slug = 'slack'
  and cm.connected_at is not null
  and exists (
    select 1 from secrets s
    where s.tenant_id = cm.tenant_id
      and s.key = 'slack.bot_token'
  )
on conflict (tenant_id, server_id) do nothing;

