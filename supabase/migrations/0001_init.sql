

create extension if not exists pgcrypto with schema extensions;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  display_name text not null,
  rar_weekly_threshold numeric default 3500,
  created_at timestamptz default now()
);

create table tenant_users (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text default 'owner',
  created_at timestamptz default now(),
  primary key (user_id, tenant_id)
);

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_tenant_id uuid references tenants(id) on delete set null,
  onboarded_at timestamptz,
  created_at timestamptz default now()
);

create table memory_docs (
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text not null,
  body_markdown text not null default '',
  updated_at timestamptz default now(),
  primary key (tenant_id, slug)
);

create table connector_metadata (
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text not null,
  team_id text,
  team_name text,
  scopes text[] default array[]::text[],
  connected_at timestamptz default now(),
  primary key (tenant_id, slug)
);

create table secrets (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,
  vault_secret_id uuid not null,
  created_at timestamptz default now(),
  primary key (tenant_id, key)
);

create table oauth_states (
  state_hash text primary key,
  provider text not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index oauth_states_expires on oauth_states (expires_at);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  agent_definition_hash text not null,
  trigger text not null,
  status text not null default 'queued',
  enqueued_by uuid references auth.users(id),
  enqueued_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz,
  prompt_snapshot text,
  raw_response_text text,
  parsed jsonb,
  parse_ok boolean,
  parse_error text,
  output_text text,
  cost_tokens int default 0,
  cost_usd numeric default 0,
  tool_calls jsonb default '[]'::jsonb,
  error text,
  inngest_run_id text,
  cron_dedupe_key text
);
create index agent_runs_tenant_started on agent_runs (tenant_id, enqueued_at desc);
create unique index agent_runs_cron_dedupe on agent_runs (cron_dedupe_key)
  where cron_dedupe_key is not null;

create table tenant_agent_schedules (
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  cron_expression text not null,
  enabled boolean not null default true,
  last_fired_at timestamptz,
  primary key (tenant_id, agent_slug)
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_run_id uuid references agent_runs(id) on delete cascade,
  decision_class text not null,
  body jsonb not null,
  status text default 'proposed',
  emitted_at timestamptz default now()
);

create type agent_run_event_stage as enum (
  'enqueued', 'claimed', 'loaded_context', 'tool_use_started',
  'tool_use_completed', 'tool_use_errored', 'iter_cap_summarize',
  'envelope_extracted', 'parsed', 'parse_failed', 'persisted',
  'completed', 'failed'
);
create table agent_run_events (
  id bigint generated always as identity primary key,
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  stage agent_run_event_stage not null,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index agent_run_events_run_created on agent_run_events (agent_run_id, created_at);

do $$
begin
  begin
    execute 'revoke all on schema vault from public, authenticated, anon';
    execute 'revoke all on all tables in schema vault from public, authenticated, anon';
    execute 'revoke all on all functions in schema vault from public, authenticated, anon';
  exception when insufficient_privilege then
    raise notice 'skipping vault REVOKEs (insufficient privilege — already locked on hosted Supabase)';
  end;
end $$;

alter table tenants                enable row level security;
alter table tenant_users           enable row level security;
alter table profiles               enable row level security;
alter table memory_docs            enable row level security;
alter table connector_metadata     enable row level security;
alter table agent_runs             enable row level security;
alter table tenant_agent_schedules enable row level security;
alter table decisions              enable row level security;
alter table agent_run_events       enable row level security;
alter table secrets       enable row level security;
alter table oauth_states  enable row level security;

create policy profiles_self_select on profiles
  for select using (user_id = auth.uid());

create policy tenant_users_self_select on tenant_users
  for select using (user_id = auth.uid());

create policy tenants_member_select on tenants
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenants.id
    )
  );

create policy memory_docs_member_select on memory_docs
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = memory_docs.tenant_id
    )
  );

create policy connector_metadata_member_select on connector_metadata
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = connector_metadata.tenant_id
    )
  );

create policy agent_runs_member_select on agent_runs
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = agent_runs.tenant_id
    )
  );

create policy tenant_agent_schedules_member_select on tenant_agent_schedules
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_agent_schedules.tenant_id
    )
  );

create policy decisions_member_select on decisions
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = decisions.tenant_id
    )
  );

create policy agent_run_events_member_select on agent_run_events
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = agent_run_events.tenant_id
    )
  );

create or replace function activate_tenant(
  p_slug text,
  p_display_name text,
  p_rar numeric,
  p_memory jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select id into v_tenant_id from tenants where slug = p_slug;
  if v_tenant_id is null then
    insert into tenants (slug, display_name, rar_weekly_threshold)
    values (p_slug, p_display_name, p_rar)
    returning id into v_tenant_id;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (auth.uid(), v_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (auth.uid(), v_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  insert into memory_docs (tenant_id, slug, body_markdown)
  select v_tenant_id, key, value
  from jsonb_each_text(p_memory)
  on conflict (tenant_id, slug)
  do update set body_markdown = excluded.body_markdown, updated_at = now();

  return v_tenant_id;
end $$;
revoke all on function activate_tenant(text, text, numeric, jsonb) from public;
grant execute on function activate_tenant(text, text, numeric, jsonb) to authenticated;

create or replace function set_active_tenant(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  insert into profiles (user_id, active_tenant_id)
  values (auth.uid(), p_tenant_id)
  on conflict (user_id) do update set active_tenant_id = excluded.active_tenant_id;
end $$;
revoke all on function set_active_tenant(uuid) from public;
grant execute on function set_active_tenant(uuid) to authenticated;

create or replace function get_secret(p_tenant_id uuid, p_key text) returns text
language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid; v_plaintext text;
begin
  select vault_secret_id into v_id from secrets
  where tenant_id = p_tenant_id and key = p_key;
  if v_id is null then return null; end if;
  select decrypted_secret into v_plaintext
  from vault.decrypted_secrets where id = v_id;
  return v_plaintext;
end $$;
revoke all on function get_secret(uuid, text) from public;

create or replace function set_slack_connection(
  p_tenant_id uuid,
  p_token text,
  p_team_id text,
  p_team_name text,
  p_scopes text[]
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

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'slack', p_team_id, p_team_name, p_scopes, now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                team_name = excluded.team_name,
                scopes = excluded.scopes,
                connected_at = excluded.connected_at;
end $$;
revoke all on function set_slack_connection(uuid, text, text, text, text[]) from public;

create or replace function mint_oauth_state(
  p_provider text,
  p_tenant_id uuid,
  p_user_id uuid,
  p_state_hash text,
  p_ttl_seconds int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into oauth_states (state_hash, provider, tenant_id, user_id, expires_at)
  values (
    p_state_hash, p_provider, p_tenant_id, p_user_id,
    now() + (p_ttl_seconds || ' seconds')::interval
  );
end $$;
revoke all on function mint_oauth_state(text, uuid, uuid, text, int) from public;

create or replace function consume_oauth_state(p_provider text, p_state_hash text)
returns table (tenant_id uuid, user_id uuid)
language plpgsql security definer set search_path = public as $$
begin
  return query
  delete from oauth_states
  where state_hash = p_state_hash
    and provider = p_provider
    and expires_at > now()
  returning oauth_states.tenant_id, oauth_states.user_id;
end $$;
revoke all on function consume_oauth_state(text, text) from public;

create or replace function enqueue_agent_run(
  p_tenant_id uuid,
  p_agent_slug text,
  p_agent_hash text,
  p_trigger text,
  p_payload jsonb,
  p_cron_dedupe_key text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_run_id uuid;
begin
  if p_trigger = 'manual' then
    if auth.uid() is null then
      raise exception 'not authenticated' using errcode = '42501';
    end if;
    if not exists (
      select 1 from tenant_users
      where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into agent_runs (
    tenant_id, agent_slug, agent_definition_hash, trigger,
    status, enqueued_by, cron_dedupe_key
  )
  values (
    p_tenant_id, p_agent_slug, p_agent_hash, p_trigger,
    'queued', auth.uid(), p_cron_dedupe_key
  )
  on conflict (cron_dedupe_key) do nothing
  returning id into v_run_id;

  return v_run_id;
end $$;
revoke all on function enqueue_agent_run(uuid, text, text, text, jsonb, text) from public;
grant execute on function enqueue_agent_run(uuid, text, text, text, jsonb, text) to authenticated;

create or replace function claim_agent_run(p_run_id uuid)
returns agent_runs
language plpgsql security definer set search_path = public as $$
declare v_row agent_runs;
begin
  update agent_runs
  set status = 'running', started_at = now()
  where id = p_run_id and status = 'queued'
  returning * into v_row;
  return v_row;
end $$;
revoke all on function claim_agent_run(uuid) from public;
