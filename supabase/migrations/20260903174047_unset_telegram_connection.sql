
create or replace function unset_telegram_connection(
  p_tenant_id uuid,
  p_chat_id bigint default null
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_disabled integer;
  v_left integer;
begin
  if p_tenant_id is null then
    if p_chat_id is null then
      raise exception 'unset_telegram_connection: need p_tenant_id or p_chat_id';
    end if;
    select tenant_id into p_tenant_id from telegram_chats where chat_id = p_chat_id;
    if p_tenant_id is null then
      return 0;
    end if;
  end if;

  update telegram_chats
     set status = 'deleted',
         updated_at = now()
   where tenant_id = p_tenant_id
     and status = 'enabled'
     and (p_chat_id is null or chat_id = p_chat_id);
  get diagnostics v_disabled = row_count;

  select count(*) into v_left
    from telegram_chats
   where tenant_id = p_tenant_id and status = 'enabled';

  if v_left = 0 then
    delete from connector_metadata
     where tenant_id = p_tenant_id and slug = 'telegram';
  end if;

  return v_disabled;
end $$;

revoke all on function unset_telegram_connection(uuid, bigint) from public;

create or replace function unset_discord_connection_for_tenant(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_disabled integer;
begin
  update discord_guilds
     set status = 'deleted',
         updated_at = now()
   where tenant_id = p_tenant_id
     and status = 'enabled';
  get diagnostics v_disabled = row_count;

  delete from connector_metadata
   where tenant_id = p_tenant_id and slug = 'discord';

  return v_disabled;
end $$;

revoke all on function unset_discord_connection_for_tenant(uuid) from public;

do $$
begin
  raise notice '20260903174047: unset_telegram_connection (per-chat or all; clears connector_metadata when no enabled chat remains) + unset_discord_connection_for_tenant';
end $$;
