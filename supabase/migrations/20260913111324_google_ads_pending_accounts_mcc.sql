
alter table google_ads_pending_connections
  add column if not exists accounts jsonb not null default '[]'::jsonb;

drop function if exists consume_google_ads_pending(uuid);

create or replace function consume_google_ads_pending(p_id uuid)
returns table(tenant_id uuid, user_id uuid, refresh_token text, customer_ids text[], accounts jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    delete from google_ads_pending_connections g
    where g.id = p_id and g.expires_at > now()
    returning g.tenant_id, g.user_id, g.refresh_token, g.customer_ids, g.accounts;
end $$;

revoke all on function consume_google_ads_pending(uuid) from public;
