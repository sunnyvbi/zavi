
create or replace function live_telegram_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_min_seconds integer default 60
) returns table (token text, expires_in integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.token, floor(extract(epoch from (t.expires_at - now())))::integer
  from telegram_link_tokens t
  where t.tenant_id = p_tenant_id
    and t.minted_by = p_minted_by
    and t.expires_at > now() + make_interval(secs => p_min_seconds)
  order by t.created_at desc
  limit 1
$$;
revoke all on function live_telegram_link_token(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function live_telegram_link_token(uuid, uuid, integer) to service_role;

create or replace function live_discord_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_min_seconds integer default 60
) returns table (token text, expires_in integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.token, floor(extract(epoch from (t.expires_at - now())))::integer
  from discord_link_tokens t
  where t.tenant_id = p_tenant_id
    and t.minted_by = p_minted_by
    and t.expires_at > now() + make_interval(secs => p_min_seconds)
  order by t.created_at desc
  limit 1
$$;
revoke all on function live_discord_link_token(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function live_discord_link_token(uuid, uuid, integer) to service_role;

create or replace function live_whatsapp_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_min_seconds integer default 60
) returns table (token text, expires_in integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.token, floor(extract(epoch from (t.expires_at - now())))::integer
  from whatsapp_link_tokens t
  where t.tenant_id = p_tenant_id
    and t.minted_by = p_minted_by
    and t.expires_at > now() + make_interval(secs => p_min_seconds)
  order by t.created_at desc
  limit 1
$$;
revoke all on function live_whatsapp_link_token(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function live_whatsapp_link_token(uuid, uuid, integer) to service_role;
