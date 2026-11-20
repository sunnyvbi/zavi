
create table if not exists telegram_chats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  chat_id bigint not null,
  chat_type text,
  chat_title text,
  status text not null default 'enabled' check (status in ('enabled','deleted')),
  bound_at timestamptz,
  bound_by_user_id uuid,
  bound_by_tg_user_id bigint,
  bound_by_tg_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_chats_chat_unique unique (chat_id)
);

create index if not exists telegram_chats_tenant_idx on telegram_chats(tenant_id);

alter table telegram_chats enable row level security;

drop policy if exists telegram_chats_select on telegram_chats;
create policy telegram_chats_select on telegram_chats
  for select
  using (
    tenant_id in (
      select tenant_id from tenant_users where user_id = auth.uid()
    )
  );

create table if not exists telegram_link_tokens (
  token text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  minted_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table telegram_link_tokens enable row level security;

create or replace function set_telegram_connection(
  p_tenant_id uuid,
  p_chat_id bigint,
  p_chat_type text,
  p_chat_title text,
  p_bound_by_user_id uuid default null,
  p_bound_by_tg_user_id bigint default null,
  p_bound_by_tg_username text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into telegram_chats (
    tenant_id, chat_id, chat_type, chat_title, status, bound_at,
    bound_by_user_id, bound_by_tg_user_id, bound_by_tg_username
  )
  values (
    p_tenant_id, p_chat_id, p_chat_type, p_chat_title, 'enabled', now(),
    p_bound_by_user_id, p_bound_by_tg_user_id, p_bound_by_tg_username
  )
  on conflict (chat_id) do update
    set tenant_id = excluded.tenant_id,
        chat_type = coalesce(excluded.chat_type, telegram_chats.chat_type),
        chat_title = coalesce(excluded.chat_title, telegram_chats.chat_title),
        status = 'enabled',
        bound_at = coalesce(telegram_chats.bound_at, now()),
        bound_by_user_id = coalesce(excluded.bound_by_user_id, telegram_chats.bound_by_user_id),
        bound_by_tg_user_id = coalesce(excluded.bound_by_tg_user_id, telegram_chats.bound_by_tg_user_id),
        bound_by_tg_username = coalesce(excluded.bound_by_tg_username, telegram_chats.bound_by_tg_username),
        updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'telegram', p_chat_id::text, null, array[]::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at;
end $$;

revoke all on function set_telegram_connection(uuid, bigint, text, text, uuid, bigint, text) from public;

create or replace function create_telegram_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_token text,
  p_ttl_seconds integer default 900
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from telegram_link_tokens where tenant_id = p_tenant_id;
  insert into telegram_link_tokens (token, tenant_id, minted_by, expires_at)
  values (p_token, p_tenant_id, p_minted_by, now() + make_interval(secs => p_ttl_seconds));
end $$;

revoke all on function create_telegram_link_token(uuid, uuid, text, integer) from public;

create or replace function consume_telegram_link_token(
  p_token text,
  p_chat_id bigint,
  p_chat_type text,
  p_chat_title text,
  p_tg_user_id bigint default null,
  p_tg_username text default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row telegram_link_tokens%rowtype;
  v_existing_tenant uuid;
begin
  delete from telegram_link_tokens
  where token = p_token and expires_at > now()
  returning * into v_row;

  if not found then
    return 'invalid_or_expired';
  end if;

  select tenant_id into v_existing_tenant
  from telegram_chats
  where chat_id = p_chat_id and status = 'enabled';

  if v_existing_tenant is not null and v_existing_tenant <> v_row.tenant_id then
    return 'chat_already_bound';
  end if;

  perform set_telegram_connection(
    v_row.tenant_id,
    p_chat_id,
    p_chat_type,
    p_chat_title,
    v_row.minted_by,
    p_tg_user_id,
    p_tg_username
  );

  return 'ok';
end $$;

revoke all on function consume_telegram_link_token(text, bigint, text, text, bigint, text) from public;

create table if not exists telegram_reply_claims (
  run_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  replied_at timestamptz not null default now()
);

alter table telegram_reply_claims enable row level security;

alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram'));

alter table memory_signal drop constraint if exists memory_signal_trigger_chk;
alter table memory_signal
  add constraint memory_signal_trigger_chk
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram'));

do $$
begin
  raise notice '20260831120000: telegram chat surface (telegram_chats + link tokens + reply claims + RPCs + trigger admit); inert until TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET set';
end $$;
