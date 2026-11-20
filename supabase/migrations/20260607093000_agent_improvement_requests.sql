
create table if not exists agent_improvement_requests (
  id                bigint      generated always as identity primary key,
  tenant_id         uuid        not null,
  agent_slug        text        not null,
  cluster_signature text        not null,
  run_ids           uuid[]      not null,
  digest_reason     text        not null,
  "window"          text        not null,
  status            text        not null default 'pending'
                    check (status in ('pending', 'leased', 'done', 'surfaced', 'skipped')),
  leased_at         timestamptz,
  leased_by         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, agent_slug, cluster_signature, "window")
);

create index if not exists agent_improvement_requests_pending_idx
  on agent_improvement_requests (created_at)
  where status = 'pending';

alter table agent_improvement_requests enable row level security;

create or replace function create_improvement_request(
  p_tenant_id        uuid,
  p_agent_slug       text,
  p_cluster_signature text,
  p_run_ids          uuid[],
  p_digest_reason    text,
  p_window           text
) returns table (request_id bigint, inserted boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_run_id        uuid;
  v_run_tenant    uuid;
  v_inserted      bigint := 0;
  v_request_id    bigint;
begin
  if p_tenant_id is null then
    raise exception 'create_improvement_request: null tenant_id' using errcode = '22023';
  end if;
  if p_agent_slug is null or char_length(p_agent_slug) < 1 then
    raise exception 'create_improvement_request: empty agent_slug' using errcode = '22023';
  end if;
  if p_cluster_signature is null or char_length(p_cluster_signature) < 8 then
    raise exception 'create_improvement_request: bad cluster_signature' using errcode = '22023';
  end if;
  if p_digest_reason is null or char_length(p_digest_reason) < 1 then
    raise exception 'create_improvement_request: empty digest_reason' using errcode = '22023';
  end if;
  if p_window is null or char_length(p_window) < 1 then
    raise exception 'create_improvement_request: empty window' using errcode = '22023';
  end if;
  if p_run_ids is null or array_length(p_run_ids, 1) is null then
    raise exception 'create_improvement_request: empty run_ids' using errcode = '22023';
  end if;

  foreach v_run_id in array p_run_ids loop
    if v_run_id is null then
      raise exception 'create_improvement_request: null run_id in run_ids' using errcode = '22023';
    end if;
    select tenant_id into v_run_tenant from agent_runs where id = v_run_id;
    if v_run_tenant is null then
      raise exception 'create_improvement_request: run % not found', v_run_id
        using errcode = '22023';
    end if;
    if v_run_tenant <> p_tenant_id then
      raise exception 'create_improvement_request: run % does not belong to tenant %',
        v_run_id, p_tenant_id using errcode = '42501';
    end if;
  end loop;

  insert into agent_improvement_requests (
    tenant_id, agent_slug, cluster_signature, run_ids, digest_reason, "window"
  ) values (
    p_tenant_id, p_agent_slug, p_cluster_signature, p_run_ids, p_digest_reason, p_window
  )
  on conflict (tenant_id, agent_slug, cluster_signature, "window") do nothing
  returning id into v_request_id;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select id into v_request_id
      from agent_improvement_requests
     where tenant_id = p_tenant_id
       and agent_slug = p_agent_slug
       and cluster_signature = p_cluster_signature
       and "window" = p_window;
  end if;

  return query select v_request_id, (v_inserted = 1);
end $$;
revoke all on function create_improvement_request(uuid, text, text, uuid[], text, text) from public;
revoke all on function create_improvement_request(uuid, text, text, uuid[], text, text) from authenticated;
grant execute on function create_improvement_request(uuid, text, text, uuid[], text, text) to service_role;
