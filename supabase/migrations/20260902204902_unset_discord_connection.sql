
create or replace function unset_discord_connection(p_guild_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
begin
  update discord_guilds
     set status = 'deleted',
         updated_at = now()
   where guild_id = p_guild_id
  returning tenant_id into v_tenant;

  if v_tenant is not null then
    delete from connector_metadata
     where tenant_id = v_tenant
       and slug = 'discord';
  end if;
end $$;

revoke all on function unset_discord_connection(text) from public;

do $$
begin
  raise notice '20260902204902: unset_discord_connection (guild unbind clears connector_metadata too)';
end $$;
