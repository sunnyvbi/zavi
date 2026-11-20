
create table if not exists discord_guilds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  guild_id text not null,
  guild_name text,
  status text not null default 'enabled' check (status in ('enabled','deleted')),
  bound_at timestamptz,
  bound_by_user_id uuid,
  bound_by_discord_user_id text,
  bound_by_discord_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discord_guilds_guild_unique unique (guild_id),
  constraint discord_guilds_tenant_unique unique (tenant_id)
);

create index if not exists discord_guilds_tenant_idx on discord_guilds(tenant_id);

alter table discord_guilds enable row level security;

drop policy if exists discord_guilds_select on discord_guilds;
create policy discord_guilds_select on discord_guilds
  for select
  using (
    tenant_id in (
      select tenant_id from tenant_users where user_id = auth.uid()
    )
  );

create table if not exists discord_link_tokens (
  token text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  minted_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table discord_link_tokens enable row level security;

create or replace function set_discord_connection(
  p_tenant_id uuid,
  p_guild_id text,
  p_guild_name text,
  p_bound_by_user_id uuid default null,
  p_bound_by_discord_user_id text default null,
  p_bound_by_discord_username text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into discord_guilds (
    tenant_id, guild_id, guild_name, status, bound_at,
    bound_by_user_id, bound_by_discord_user_id, bound_by_discord_username
  )
  values (
    p_tenant_id, p_guild_id, p_guild_name, 'enabled', now(),
    p_bound_by_user_id, p_bound_by_discord_user_id, p_bound_by_discord_username
  )
  on conflict (tenant_id) do update
    set guild_id = excluded.guild_id,
        guild_name = coalesce(excluded.guild_name, discord_guilds.guild_name),
        status = 'enabled',
        bound_at = coalesce(discord_guilds.bound_at, now()),
        bound_by_user_id = coalesce(excluded.bound_by_user_id, discord_guilds.bound_by_user_id),
        bound_by_discord_user_id = coalesce(excluded.bound_by_discord_user_id, discord_guilds.bound_by_discord_user_id),
        bound_by_discord_username = coalesce(excluded.bound_by_discord_username, discord_guilds.bound_by_discord_username),
        updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'discord', p_guild_id, p_guild_name, array[]::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                team_name = excluded.team_name,
                connected_at = excluded.connected_at;
end $$;

revoke all on function set_discord_connection(uuid, text, text, uuid, text, text) from public;

create or replace function create_discord_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_token text,
  p_ttl_seconds integer default 900
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from discord_link_tokens where tenant_id = p_tenant_id;
  insert into discord_link_tokens (token, tenant_id, minted_by, expires_at)
  values (p_token, p_tenant_id, p_minted_by, now() + make_interval(secs => p_ttl_seconds));
end $$;

revoke all on function create_discord_link_token(uuid, uuid, text, integer) from public;

create or replace function consume_discord_link_token(
  p_token text,
  p_guild_id text,
  p_guild_name text,
  p_discord_user_id text default null,
  p_discord_username text default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row discord_link_tokens%rowtype;
  v_existing_tenant uuid;
  v_existing_guild text;
begin
  delete from discord_link_tokens
  where token = p_token and expires_at > now()
  returning * into v_row;

  if not found then
    return 'invalid_or_expired';
  end if;

  select tenant_id into v_existing_tenant
  from discord_guilds
  where guild_id = p_guild_id and status = 'enabled';

  if v_existing_tenant is not null and v_existing_tenant <> v_row.tenant_id then
    return 'guild_already_bound';
  end if;

  select guild_id into v_existing_guild
  from discord_guilds
  where tenant_id = v_row.tenant_id and status = 'enabled';

  if v_existing_guild is not null and v_existing_guild <> p_guild_id then
    return 'tenant_already_bound';
  end if;

  perform set_discord_connection(
    v_row.tenant_id,
    p_guild_id,
    p_guild_name,
    v_row.minted_by,
    p_discord_user_id,
    p_discord_username
  );

  return 'ok';
end $$;

revoke all on function consume_discord_link_token(text, text, text, text, text) from public;

create table if not exists discord_gateway_lease (
  id int primary key check (id = 1),
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table discord_gateway_lease enable row level security;

create or replace function claim_discord_gateway_lease(
  p_holder text,
  p_ttl_seconds integer default 60
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into discord_gateway_lease as l (id, holder, acquired_at, expires_at)
  values (1, p_holder, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (id) do update
    set holder = excluded.holder,
        acquired_at = case when l.holder = excluded.holder then l.acquired_at else now() end,
        expires_at = excluded.expires_at
    where l.holder = excluded.holder or l.expires_at < now();
  return found;
end $$;

revoke all on function claim_discord_gateway_lease(text, integer) from public;

create or replace function release_discord_gateway_lease(
  p_holder text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from discord_gateway_lease where id = 1 and holder = p_holder;
end $$;

revoke all on function release_discord_gateway_lease(text) from public;

create or replace function ingest_and_enqueue_work(
  p_tenant_id uuid,
  p_provider text,
  p_external_event_id text,
  p_event_type text,
  p_ingest_payload jsonb,
  p_agent_slug text,
  p_source text,
  p_work_payload jsonb,
  p_dedupe_key text default null,
  p_work_type text default null,
  p_lane text default 'e2b'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ingest_id uuid;
  v_work_id uuid;
begin
  v_ingest_id := ingest_event(
    p_tenant_id, p_provider, p_external_event_id, p_event_type, p_ingest_payload
  );
  if v_ingest_id is null then
    return jsonb_build_object('duplicate', true);
  end if;

  v_work_id := enqueue_work_item(
    p_tenant_id, p_agent_slug, p_source,
    jsonb_set(
      coalesce(p_work_payload, '{}'::jsonb),
      '{ingested_event_id}',
      to_jsonb(v_ingest_id::text)
    ),
    p_dedupe_key, 0, now(), null, p_work_type, p_lane
  );

  return jsonb_build_object(
    'duplicate', false,
    'ingested_event_id', v_ingest_id,
    'work_item_id', v_work_id
  );
end $$;

revoke all on function ingest_and_enqueue_work(uuid, text, text, text, jsonb, text, text, jsonb, text, text, text) from public;

create table if not exists discord_reply_claims (
  run_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  replied_at timestamptz not null default now()
);

alter table discord_reply_claims enable row level security;

alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram','discord'));

alter table memory_signal drop constraint if exists memory_signal_trigger_chk;
alter table memory_signal
  add constraint memory_signal_trigger_chk
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram','discord'));

do $$
begin
  raise notice '20260901120000: discord chat surface (discord_guilds + link tokens + gateway lease + atomic ingest+enqueue + reply claims + RPCs + trigger admit); inert until DISCORD_BOT_TOKEN set';
end $$;
