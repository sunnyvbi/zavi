
create table if not exists browser_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid,
  engine text not null check (engine in ('sandbox', 'anchor')),
  provider_session_id text,
  anchor_profile_id text,
  origin text,
  status text not null default 'open' check (status in ('open', 'closed', 'failed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  browser_seconds integer not null default 0,
  proxy_bytes bigint not null default 0,
  close_reason text
);

create index if not exists browser_sessions_tenant_open_idx
  on browser_sessions (tenant_id)
  where status = 'open';

create index if not exists browser_sessions_tenant_opened_idx
  on browser_sessions (tenant_id, opened_at);

alter table browser_sessions enable row level security;

create policy browser_sessions_member_select on browser_sessions
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = browser_sessions.tenant_id
    )
  );

create or replace function open_browser_session(
  p_tenant_id uuid,
  p_run_id uuid,
  p_engine text,
  p_origin text default null,
  p_anchor_profile_id text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_max_concurrent int := 3;
  v_monthly_budget_seconds bigint := 360000;
  v_open_count int;
  v_used_seconds bigint;
  v_id uuid;
begin
  if p_engine = 'anchor' then
    select count(*) into v_open_count from browser_sessions
      where tenant_id = p_tenant_id and engine = 'anchor' and status = 'open';
    if v_open_count >= v_max_concurrent then
      raise exception
        'browser_session_concurrency_exceeded: tenant % has % open anchor sessions (max %)',
        p_tenant_id, v_open_count, v_max_concurrent
        using errcode = 'check_violation';
    end if;

    select coalesce(sum(browser_seconds), 0) into v_used_seconds
      from browser_sessions
      where tenant_id = p_tenant_id and engine = 'anchor'
        and opened_at >= date_trunc('month', now());
    if v_used_seconds >= v_monthly_budget_seconds then
      raise exception
        'browser_session_budget_exceeded: tenant % used %s of %s monthly anchor seconds',
        p_tenant_id, v_used_seconds, v_monthly_budget_seconds
        using errcode = 'check_violation';
    end if;
  end if;

  insert into browser_sessions
    (tenant_id, run_id, engine, origin, anchor_profile_id, status)
  values
    (p_tenant_id, p_run_id, p_engine, p_origin, p_anchor_profile_id, 'open')
  returning id into v_id;
  return v_id;
end $$;

revoke all on function open_browser_session(uuid, uuid, text, text, text) from public;

create or replace function close_browser_session(
  p_session_id uuid,
  p_browser_seconds int default 0,
  p_proxy_bytes bigint default 0,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update browser_sessions
    set status = 'closed',
        closed_at = now(),
        browser_seconds = greatest(browser_seconds, coalesce(p_browser_seconds, 0)),
        proxy_bytes = greatest(proxy_bytes, coalesce(p_proxy_bytes, 0)),
        close_reason = coalesce(p_reason, close_reason)
    where id = p_session_id and status = 'open';
end $$;

revoke all on function close_browser_session(uuid, int, bigint, text) from public;
