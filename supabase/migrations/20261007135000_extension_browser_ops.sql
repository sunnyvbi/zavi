
begin;

create table if not exists public.extension_panel_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  tab_id int not null,
  attached_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (id, tenant_id, user_id)
);

comment on table public.extension_panel_sessions is
  'Chrome-extension side-panel sessions (one per attach to one tab). Server writes only. Dead after 30s without a long-poll or heartbeat.';

alter table public.extension_panel_sessions enable row level security;
revoke all on public.extension_panel_sessions from public, anon, authenticated;

create table if not exists public.extension_browser_ops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  panel_session_id uuid not null,
  tab_id int not null,
  seq int not null,
  op jsonb not null,
  is_write boolean not null,
  status text not null default 'queued' check (status in (
    'queued', 'delivered', 'lease_expired', 'done', 'failed',
    'unknown', 'awaiting_confirm', 'expired'
  )),
  execution_token uuid,
  lease_until timestamptz,
  result jsonb,
  idempotency_key text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (run_id, seq),
  foreign key (panel_session_id, tenant_id, user_id)
    references public.extension_panel_sessions (id, tenant_id, user_id)
    on delete cascade
);

comment on table public.extension_browser_ops is
  'Browser ops queued for one Chrome-extension panel session. Delivered only to the owning (tenant, user, session); results accepted only with the matching run + execution_token under a live lease. A lapsed WRITE becomes unknown and is never re-sent.';

create index if not exists extension_browser_ops_session_idx
  on public.extension_browser_ops (panel_session_id, created_at);

alter table public.extension_browser_ops enable row level security;
revoke all on public.extension_browser_ops from public, anon, authenticated;

create or replace function public.claim_extension_op(
  p_tenant_id uuid,
  p_user_id uuid,
  p_session_id uuid
) returns setof public.extension_browser_ops
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_row public.extension_browser_ops;
begin
  if p_tenant_id is null or p_user_id is null or p_session_id is null then
    raise exception 'tenant_id, user_id and session_id are required' using errcode = '22023';
  end if;

  perform 1 from public.extension_panel_sessions s
    where s.id = p_session_id
      and s.tenant_id = p_tenant_id
      and s.user_id = p_user_id
      and s.ended_at is null
      and s.last_seen_at > now() - interval '30 seconds'
    for update;
  if not found then
    return;
  end if;

  perform 1 from public.extension_consent c
    where c.tenant_id = p_tenant_id
      and c.user_id = p_user_id
      and c.revoked_at is null
    for share;
  if not found then
    return;
  end if;

  update public.extension_browser_ops o
     set status = case when o.is_write then 'unknown' else 'lease_expired' end
   where o.tenant_id = p_tenant_id
     and o.user_id = p_user_id
     and o.panel_session_id = p_session_id
     and o.status = 'delivered'
     and o.lease_until <= now();

  select o.id into v_id
    from public.extension_browser_ops o
   where o.tenant_id = p_tenant_id
     and o.user_id = p_user_id
     and o.panel_session_id = p_session_id
     and o.status in ('queued', 'lease_expired')
     and o.expires_at > now()
   order by o.created_at, o.seq
   limit 1
   for update skip locked;

  if v_id is null then
    return;
  end if;

  update public.extension_browser_ops o
     set status = 'delivered',
         execution_token = gen_random_uuid(),
         lease_until = now() + interval '15 seconds'
   where o.id = v_id
  returning o.* into v_row;

  return next v_row;
  return;
end $$;

revoke all on function public.claim_extension_op(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_extension_op(uuid, uuid, uuid) to service_role;

comment on function public.claim_extension_op(uuid, uuid, uuid) is
  'Atomically delivers the oldest claimable op to a live panel session owned by (tenant, user), with a fresh execution_token and a 15s lease. Lapsed write deliveries become unknown and are never re-delivered.';

create or replace function public.complete_extension_op(
  p_op_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_run_id uuid,
  p_token uuid,
  p_status text,
  p_result jsonb
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_status is null or p_status not in ('done', 'failed') then
    raise exception 'status must be done or failed' using errcode = '22023';
  end if;

  update public.extension_browser_ops o
     set status = p_status,
         result = p_result
   where o.id = p_op_id
     and o.tenant_id = p_tenant_id
     and o.user_id = p_user_id
     and o.panel_session_id = p_session_id
     and o.run_id = p_run_id
     and o.execution_token = p_token
     and o.status = 'delivered'
     and o.lease_until > now()
     and exists (
       select 1 from public.extension_panel_sessions s
       where s.id = p_session_id
         and s.tenant_id = p_tenant_id
         and s.user_id = p_user_id
         and s.ended_at is null
         and s.last_seen_at > now() - interval '30 seconds'
     )
  returning o.id into v_id;

  return v_id is not null;
end $$;

revoke all on function public.complete_extension_op(uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_extension_op(uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb) to service_role;

comment on function public.complete_extension_op(uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb) is
  'Records a panel''s result for one delivered op. Accepted only when op id, tenant, user, panel session, run and execution_token all match, the lease and the session are live, and status is delivered. Returns false otherwise.';

commit;
