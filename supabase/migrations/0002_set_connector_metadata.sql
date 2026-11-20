
create or replace function set_connector_metadata(
  p_tenant_id uuid,
  p_slug text,
  p_team_id text,
  p_team_name text,
  p_scopes text[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, p_slug, p_team_id, p_team_name, p_scopes, now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                team_name = excluded.team_name,
                scopes = excluded.scopes,
                connected_at = excluded.connected_at;
end $$;
revoke all on function set_connector_metadata(uuid, text, text, text, text[]) from public;
