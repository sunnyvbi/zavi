
begin;

create table channel_run_claims (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  channel_slug  text not null check (char_length(channel_slug) between 1 and 64),
  request_id    text not null check (char_length(request_id) between 8 and 200),
  estimate      int  not null check (estimate >= 0),
  run_id        uuid references agent_runs(id) on delete set null,
  claimed_at    timestamptz not null default now(),
  settled_at    timestamptz,
  unique (tenant_id, channel_slug, request_id)
);

create index channel_run_claims_pending
  on channel_run_claims (tenant_id, claimed_at)
  where settled_at is null;

alter table channel_run_claims enable row level security;

create policy channel_run_claims_member_select on channel_run_claims
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = channel_run_claims.tenant_id
    )
  );
create policy channel_run_claims_active_tenant_restrict
  on channel_run_claims as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke all on table channel_run_claims from anon, authenticated;
grant select on table channel_run_claims to authenticated;

create or replace function channel_claim_stale_after()
returns interval language sql immutable set search_path = public, pg_temp as $$
  select interval '5 minutes';
$$;

create or replace function claim_channel_run(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_request_id   text,
  p_estimate     int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key      text := left(nullif(btrim(p_request_id), ''), 200);
  v_est      int  := greatest(coalesce(p_estimate, 0), 0);
  v_claim_id uuid;
  v_run_id   uuid;
  v_pending  int;
begin
  if p_tenant_id is null then
    raise exception 'claim_channel_run: tenant_id required' using errcode = 'P0001';
  end if;
  if p_channel_slug is null or length(btrim(p_channel_slug)) = 0 then
    raise exception 'claim_channel_run: channel_slug required' using errcode = 'P0001';
  end if;
  if v_key is null or char_length(v_key) < 8 then
    raise exception 'claim_channel_run: request_id must be 8-200 chars' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('channel_run_claim:' || p_tenant_id::text, 0));

  select id, run_id into v_claim_id, v_run_id
    from channel_run_claims
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and request_id = v_key;
  if v_claim_id is not null then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'claim_id', v_claim_id, 'run_id', v_run_id);
  end if;

  select coalesce(sum(estimate), 0)::int into v_pending
    from channel_run_claims
   where tenant_id = p_tenant_id
     and settled_at is null
     and claimed_at > now() - channel_claim_stale_after();

  if not channel_budget_allows(p_tenant_id, v_est + v_pending) then
    return jsonb_build_object(
      'ok', false, 'reason', 'cap_reached',
      'spent_30d', channel_credits_30d(p_tenant_id) + v_pending);
  end if;

  insert into channel_run_claims (tenant_id, channel_slug, request_id, estimate)
  values (p_tenant_id, p_channel_slug, v_key, v_est)
  on conflict (tenant_id, channel_slug, request_id) do nothing
  returning id into v_claim_id;

  if v_claim_id is null then
    select id, run_id into v_claim_id, v_run_id
      from channel_run_claims
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and request_id = v_key;
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'claim_id', v_claim_id, 'run_id', v_run_id);
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'claim_id', v_claim_id);
end $$;

create or replace function settle_channel_run_claim(
  p_tenant_id          uuid,
  p_claim_id           uuid,
  p_run_id             uuid,
  p_visible_to_ledger  boolean default true
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hit int;
begin
  update channel_run_claims
     set run_id     = coalesce(run_id, p_run_id),
         settled_at = case when coalesce(p_visible_to_ledger, true)
                           then coalesce(settled_at, now())
                           else settled_at end
   where id = p_claim_id
     and tenant_id = p_tenant_id;
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;

create or replace function release_channel_run_claim(
  p_tenant_id uuid,
  p_claim_id  uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hit int;
begin
  delete from channel_run_claims
   where id = p_claim_id
     and tenant_id = p_tenant_id
     and run_id is null;
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;

revoke all on function channel_claim_stale_after()                from public, anon, authenticated;
revoke all on function claim_channel_run(uuid, text, text, int)   from public, anon, authenticated;
revoke all on function settle_channel_run_claim(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function release_channel_run_claim(uuid, uuid)      from public, anon, authenticated;
grant execute on function channel_claim_stale_after()                to service_role;
grant execute on function claim_channel_run(uuid, text, text, int)   to service_role;
grant execute on function settle_channel_run_claim(uuid, uuid, uuid, boolean) to service_role;
grant execute on function release_channel_run_claim(uuid, uuid)      to service_role;

commit;

do $$
begin
  raise notice '20260920083304: channel_run_claims — (tenant, channel, request_id) unique + per-tenant advisory-locked cap admission';
end $$;
