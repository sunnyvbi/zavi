
alter table agent_runs
  add constraint agent_runs_id_tenant_uq unique (id, tenant_id);

create table if not exists agent_run_steers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  run_id          uuid not null,
  thread_id       text,
  agent_slug      text not null,
  author_user_id  uuid references auth.users(id) on delete set null,
  seq             bigint not null,
  body            text not null,
  origin          text not null check (origin in ('chat','slack','email','teams')),
  idempotency_key text,
  status          text not null default 'pending'
                    check (status in ('pending','leased','injected','drained',
                                      'rerouting','rerouted','dead')),
  lease_until     timestamptz,
  drained_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint agent_run_steers_run_tenant_fk
    foreign key (run_id, tenant_id) references agent_runs (id, tenant_id) on delete cascade
);

create unique index if not exists agent_run_steers_run_seq_uq
  on agent_run_steers (run_id, seq);

create unique index if not exists agent_run_steers_run_idem_uq
  on agent_run_steers (run_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_run_steers_pending_idx
  on agent_run_steers (run_id, seq)
  where status = 'pending';

comment on table agent_run_steers is
  'Mid-run barge-in steer channel. Inert until an engine adapter (Slice 3/4) drains it behind agent_barge_in_enabled (Slice 8). Writes ONLY via enqueue_or_steer_chat_turn (chat) / enqueue_agent_run_steer (webhook).';

alter table agent_run_steers enable row level security;

create policy agent_run_steers_select_owner
  on agent_run_steers for select to authenticated
  using (
    exists (
      select 1 from public.agent_threads t
      where t.id::text = agent_run_steers.thread_id
        and t.tenant_id = agent_run_steers.tenant_id
        and t.user_id = auth.uid()
    )
  );

create or replace function enqueue_or_steer_chat_turn(
  p_tenant_id         uuid,
  p_thread_id         text,
  p_agent_slug        text,
  p_body              text,
  p_idempotency_key   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_run_id   uuid;
  v_seq      bigint;
  v_steer_id uuid;
  v_existing uuid;
begin
  if v_uid is null then
    raise exception 'enqueue_or_steer_chat_turn: no authenticated caller';
  end if;
  if not exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = p_tenant_id and tu.user_id = v_uid
  ) then
    raise exception 'enqueue_or_steer_chat_turn: caller % not a member of tenant %', v_uid, p_tenant_id;
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'enqueue_or_steer_chat_turn: empty body';
  end if;
  if length(p_body) > 8000 then
    raise exception 'enqueue_or_steer_chat_turn: body exceeds 8000 chars';
  end if;

  if not coalesce(
       (select (blob->>'agent_barge_in_enabled')::boolean from public.system_config where id = 1),
       false) then
    return jsonb_build_object('action', 'new_turn', 'reason', 'flag_off');
  end if;

  if not exists (
    select 1 from public.agent_threads t
    where t.id::text = p_thread_id
      and t.tenant_id = p_tenant_id
      and t.user_id = v_uid
  ) then
    return jsonb_build_object('action', 'new_turn', 'reason', 'not_thread_owner');
  end if;

  select id into v_run_id
  from public.agent_runs
  where tenant_id = p_tenant_id
    and status = 'running'
    and payload->>'thread_id' = p_thread_id
  order by started_at desc nulls last
  limit 1
  for update;

  if v_run_id is null then
    return jsonb_build_object('action', 'new_turn', 'reason', 'no_running_run');
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
    from public.agent_run_steers
    where run_id = v_run_id and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('action', 'steered', 'steer_id', v_existing,
                                'run_id', v_run_id, 'dedup', true);
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
  from public.agent_run_steers where run_id = v_run_id;

  insert into public.agent_run_steers
    (tenant_id, run_id, thread_id, agent_slug, author_user_id, seq, body, origin, idempotency_key)
  values
    (p_tenant_id, v_run_id, p_thread_id, p_agent_slug, v_uid, v_seq, p_body, 'chat', p_idempotency_key)
  returning id into v_steer_id;

  return jsonb_build_object('action', 'steered', 'steer_id', v_steer_id, 'run_id', v_run_id);
end;
$$;

revoke all on function enqueue_or_steer_chat_turn(uuid, text, text, text, text) from public, anon;
grant execute on function enqueue_or_steer_chat_turn(uuid, text, text, text, text) to authenticated, service_role;

create or replace function enqueue_agent_run_steer(
  p_tenant_id        uuid,
  p_run_id           uuid,
  p_thread_id        text,
  p_agent_slug       text,
  p_author_user_id   uuid,
  p_body             text,
  p_origin           text,
  p_idempotency_key  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status   text;
  v_seq      bigint;
  v_steer_id uuid;
  v_existing uuid;
begin
  if p_origin not in ('slack','email','teams') then
    raise exception 'enqueue_agent_run_steer: origin % not a webhook surface', p_origin;
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'enqueue_agent_run_steer: empty body';
  end if;
  if length(p_body) > 8000 then
    raise exception 'enqueue_agent_run_steer: body exceeds 8000 chars';
  end if;

  if not coalesce(
       (select (blob->>'agent_barge_in_enabled')::boolean from public.system_config where id = 1),
       false) then
    return jsonb_build_object('action', 'not_running', 'reason', 'flag_off');
  end if;

  select status into v_status
  from public.agent_runs
  where id = p_run_id
    and tenant_id = p_tenant_id
  for update;

  if v_status is null then
    return jsonb_build_object('action', 'not_running', 'reason', 'run_unresolved');
  end if;
  if v_status <> 'running' then
    return jsonb_build_object('action', 'not_running', 'reason', 'run_' || v_status);
  end if;

  if p_author_user_id is not null and not exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = p_tenant_id and tu.user_id = p_author_user_id
  ) then
    raise exception 'enqueue_agent_run_steer: author % not a member of tenant %', p_author_user_id, p_tenant_id;
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
    from public.agent_run_steers
    where run_id = p_run_id and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('action', 'steered', 'steer_id', v_existing,
                                'run_id', p_run_id, 'dedup', true);
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
  from public.agent_run_steers where run_id = p_run_id;

  insert into public.agent_run_steers
    (tenant_id, run_id, thread_id, agent_slug, author_user_id, seq, body, origin, idempotency_key)
  values
    (p_tenant_id, p_run_id, p_thread_id, p_agent_slug, p_author_user_id, v_seq, p_body, p_origin, p_idempotency_key)
  returning id into v_steer_id;

  return jsonb_build_object('action', 'steered', 'steer_id', v_steer_id, 'run_id', p_run_id);
end;
$$;

revoke all on function enqueue_agent_run_steer(uuid, uuid, text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function enqueue_agent_run_steer(uuid, uuid, text, text, uuid, text, text, text) to service_role;
