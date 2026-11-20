
create or replace function creator_resolve_thread(p_thread_id uuid)
returns table (
  tenant_id       uuid,
  human_member_id uuid,
  started_by      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.tenant_id, t.human_member_id, t.started_by
    from creator_threads t
   where t.id = p_thread_id
$$;

comment on function creator_resolve_thread(uuid) is
  'Pre-tenant READ-ONLY resolver (slice S8). Returns the owning tenant + creator of one creator thread so a tenant-less creator caller can re-enter the tenant-scoped facade with a server-derived id. Authorizes nothing.';

create or replace function creator_resolve_offer(p_offer_id uuid)
returns table (
  tenant_id       uuid,
  human_member_id uuid,
  thread_id       uuid,
  proposed_by     text,
  status          text,
  expires_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.tenant_id, o.human_member_id, o.thread_id,
         o.proposed_by, o.status, o.expires_at
    from creator_offers o
   where o.id = p_offer_id
$$;

comment on function creator_resolve_offer(uuid) is
  'Pre-tenant READ-ONLY resolver (slice S8). Returns the owning tenant + creator of one custom offer, plus proposed_by / status / expires_at. Authorizes nothing.';

revoke all on function creator_resolve_thread(uuid) from public, anon, authenticated;
revoke all on function creator_resolve_offer(uuid)  from public, anon, authenticated;
grant execute on function creator_resolve_thread(uuid) to service_role;
grant execute on function creator_resolve_offer(uuid)  to service_role;
