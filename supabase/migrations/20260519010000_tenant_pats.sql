
create table tenant_pats (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null,
  token_hash    text not null,
  token_salt    text not null,
  token_prefix  text not null,
  name          text not null,
  scopes        text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);

create unique index tenant_pats_token_hash_uidx on tenant_pats(token_hash);
create index tenant_pats_lookup_idx on tenant_pats(user_id, tenant_id) where revoked_at is null;
create index tenant_pats_prefix_idx on tenant_pats(token_prefix) where revoked_at is null;

alter table tenant_pats enable row level security;

create policy tenant_pats_self_read on tenant_pats
  for select using (user_id = auth.uid());

create table mcp_tool_calls (
  id          bigint generated always as identity primary key,
  pat_id      uuid not null references tenant_pats(id) on delete cascade,
  user_id     uuid not null,
  tenant_id   uuid not null,
  tool        text not null,
  args_hash   text,
  ip_hash     text,
  ms          integer not null,
  code        text not null,
  created_at  timestamptz not null default now()
);

create index mcp_tool_calls_tenant_idx on mcp_tool_calls(tenant_id, created_at desc);
create index mcp_tool_calls_pat_idx on mcp_tool_calls(pat_id, created_at desc);

alter table mcp_tool_calls enable row level security;

create or replace function mint_tenant_pat(
  p_tenant_id    uuid,
  p_user_id      uuid,
  p_token_hash   text,
  p_token_salt   text,
  p_token_prefix text,
  p_name         text,
  p_scopes       text[],
  p_expires_at   timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into tenant_pats(tenant_id, user_id, token_hash, token_salt,
                          token_prefix, name, scopes, expires_at)
  values (p_tenant_id, p_user_id, p_token_hash, p_token_salt,
          p_token_prefix, p_name, coalesce(p_scopes, '{}'),
          coalesce(p_expires_at, now() + interval '90 days'))
  returning id into v_id;
  return v_id;
end $$;

create or replace function revoke_tenant_pat(
  p_pat_id  uuid,
  p_user_id uuid
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update tenant_pats
     set revoked_at = now()
   where id = p_pat_id
     and user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

revoke all on function mint_tenant_pat(uuid, uuid, text, text, text, text, text[], timestamptz) from public, anon, authenticated;
grant execute on function mint_tenant_pat(uuid, uuid, text, text, text, text, text[], timestamptz) to service_role;
revoke all on function revoke_tenant_pat(uuid, uuid) from public, anon, authenticated;
grant execute on function revoke_tenant_pat(uuid, uuid) to service_role;

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
grant execute on function enqueue_agent_run(uuid, text, text, text, jsonb, text) to service_role;

do $$
declare
  c_name text;
begin
  select conname into c_name
    from pg_constraint
   where conrelid = 'agent_runs'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%trigger%';
  if c_name is not null then
    execute format('alter table agent_runs drop constraint %I', c_name);
  end if;
  alter table agent_runs
    add constraint agent_runs_trigger_check
    check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp'));
end $$;
