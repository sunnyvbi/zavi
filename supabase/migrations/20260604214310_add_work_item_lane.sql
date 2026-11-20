
alter table agent_work_items
  add column if not exists lane text not null default 'e2b' check (lane in ('e2b','local')),
  add column if not exists work_type text;

create index if not exists agent_work_items_lane_claim_idx
  on agent_work_items (lane, status, next_run_at, priority desc)
  where status = 'pending';

drop function if exists claim_agent_work_items(text, int, int);
create function claim_agent_work_items(
  p_owner        text,
  p_limit        int default 10,
  p_lease_seconds int default 300,
  p_lane         text default 'e2b',
  p_tenant_id    uuid default null
) returns setof agent_work_items
language plpgsql security definer set search_path = public as $$
begin
  return query
  update agent_work_items w
     set status = 'leased',
         lease_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = w.attempts + 1,
         updated_at = now()
   where w.id in (
     select id from agent_work_items
      where status = 'pending' and next_run_at <= now()
        and lane = p_lane
        and (p_tenant_id is null or tenant_id = p_tenant_id)
      order by priority desc, next_run_at asc
      limit p_limit
      for update skip locked
   )
  returning w.*;
end $$;
revoke all on function claim_agent_work_items(text, int, int, text, uuid) from public;
grant execute on function claim_agent_work_items(text, int, int, text, uuid) to service_role;

drop function if exists enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text);
create function enqueue_work_item(
  p_tenant_id   uuid,
  p_agent_slug  text,
  p_source      text,
  p_payload     jsonb default null,
  p_dedupe_key  text default null,
  p_priority    int  default 0,
  p_next_run_at timestamptz default now(),
  p_risk_tier   text default null,
  p_work_type   text default null,
  p_lane        text default 'e2b'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_lane text := coalesce(p_lane, 'e2b');
begin
  if auth.role() is distinct from 'service_role' then
    if p_source in ('chat', 'manual') then
      if not exists (select 1 from tenant_users
                     where user_id = auth.uid() and tenant_id = p_tenant_id) then
        raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
      end if;
    end if;
    v_lane := 'e2b';
  end if;

  insert into agent_work_items (tenant_id, agent_slug, source, payload,
                               dedupe_key, priority, next_run_at, risk_tier,
                               work_type, lane)
  values (p_tenant_id, p_agent_slug, p_source, p_payload,
          p_dedupe_key, p_priority, p_next_run_at, p_risk_tier,
          p_work_type, v_lane)
  on conflict (tenant_id, agent_slug, dedupe_key)
    where dedupe_key is not null and status in ('pending', 'leased')
    do nothing
  returning id into v_id;

  if v_id is null and p_dedupe_key is not null then
    select id into v_id from agent_work_items
    where tenant_id = p_tenant_id and agent_slug = p_agent_slug
      and dedupe_key = p_dedupe_key and status in ('pending', 'leased')
    order by created_at desc limit 1;
  end if;

  return v_id;
end $$;
revoke all on function enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text, text, text) from public;
grant execute on function enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text, text, text) to authenticated, service_role;

create function complete_local_work_item(
  p_id           uuid,
  p_tenant_id    uuid,
  p_owner        text,
  p_status       text,
  p_agent_run_id uuid default null,
  p_last_error   text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_status not in ('done', 'failed', 'dropped') then
    raise exception 'invalid terminal status %', p_status using errcode = '22023';
  end if;
  update agent_work_items
     set status = p_status,
         agent_run_id = coalesce(p_agent_run_id, agent_run_id),
         last_error = p_last_error,
         lease_owner = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_id
     and tenant_id = p_tenant_id
     and lane = 'local'
     and status = 'leased'
     and lease_owner = p_owner;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function complete_local_work_item(uuid, uuid, text, text, uuid, text) from public;
grant execute on function complete_local_work_item(uuid, uuid, text, text, uuid, text) to service_role;

create function renew_local_lease(
  p_id            uuid,
  p_tenant_id     uuid,
  p_owner         text,
  p_lease_seconds int default 3600
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update agent_work_items
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = p_id
     and tenant_id = p_tenant_id
     and lane = 'local'
     and status = 'leased'
     and lease_owner = p_owner;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function renew_local_lease(uuid, uuid, text, int) from public;
grant execute on function renew_local_lease(uuid, uuid, text, int) to service_role;

create function insert_terminal_local_agent_run(
  p_tenant_id   uuid,
  p_agent_slug  text,
  p_trigger     text,
  p_status      text,
  p_output_text text default null,
  p_parse_ok    boolean default true,
  p_def_hash    text default 'local'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_status not in ('success', 'parse_failed', 'dispatch_error') then
    raise exception 'invalid local run status %', p_status using errcode = '22023';
  end if;
  insert into agent_runs (
    tenant_id, agent_slug, agent_definition_hash, trigger, status,
    enqueued_at, started_at, finished_at, parse_ok, output_text,
    cost_tokens, cost_usd, tool_calls
  ) values (
    p_tenant_id, p_agent_slug, coalesce(p_def_hash, 'local'), p_trigger, p_status,
    now(), now(), now(), p_parse_ok, p_output_text,
    0, 0, '[]'::jsonb
  ) returning id into v_id;
  return v_id;
end $$;
revoke all on function insert_terminal_local_agent_run(uuid, text, text, text, text, boolean, text) from public;
grant execute on function insert_terminal_local_agent_run(uuid, text, text, text, text, boolean, text) to service_role;
