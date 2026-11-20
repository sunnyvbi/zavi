
create table mac_worker_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null,
  token_salt   text not null,
  token_prefix text not null,
  label        text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);
create unique index mac_worker_tokens_token_hash_uidx on mac_worker_tokens(token_hash);
create index mac_worker_tokens_prefix_idx on mac_worker_tokens(token_prefix) where revoked_at is null;

create table mac_worker_token_tenants (
  token_id  uuid not null references mac_worker_tokens(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  primary key (token_id, tenant_id)
);
create index mac_worker_token_tenants_token_idx on mac_worker_token_tenants(token_id);

alter table mac_worker_tokens enable row level security;
alter table mac_worker_token_tenants enable row level security;

alter table agent_work_items add column if not exists finalize_claimed_at timestamptz;

create function mint_mac_worker_token(
  p_token_hash   text,
  p_token_salt   text,
  p_token_prefix text,
  p_label        text,
  p_tenant_ids   uuid[]
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_tid uuid;
begin
  if p_tenant_ids is null or array_length(p_tenant_ids, 1) is null then
    raise exception 'mac worker token must be scoped to >=1 tenant' using errcode = '22023';
  end if;
  insert into mac_worker_tokens(token_hash, token_salt, token_prefix, label)
  values (p_token_hash, p_token_salt, p_token_prefix, p_label)
  returning id into v_id;
  foreach v_tid in array p_tenant_ids loop
    insert into mac_worker_token_tenants(token_id, tenant_id) values (v_id, v_tid);
  end loop;
  return v_id;
end $$;

create function revoke_mac_worker_token(p_token_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update mac_worker_tokens set revoked_at = now()
   where id = p_token_id and revoked_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create function mac_worker_can_access(p_token_id uuid, p_tenant_id uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from mac_worker_tokens t
    where t.id = p_token_id and t.revoked_at is null
  ) and exists (
    select 1 from mac_worker_token_tenants mt
    where mt.token_id = p_token_id and mt.tenant_id = p_tenant_id
  ) and coalesce(
    (select tll.enabled from tenant_local_lane tll where tll.tenant_id = p_tenant_id),
    false
  );
$$;

create function claim_local_run_terminal(
  p_run_id    uuid,
  p_tenant_id uuid,
  p_owner     text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_item_id uuid;
begin
  update agent_work_items w
     set finalize_claimed_at = now(), updated_at = now()
   from agent_runs r
   where w.agent_run_id = p_run_id
     and w.tenant_id = p_tenant_id
     and w.lane = 'local'
     and w.status = 'leased'
     and w.lease_owner = p_owner
     and w.finalize_claimed_at is null
     and r.id = p_run_id
     and r.tenant_id = p_tenant_id
     and r.status = 'running'
  returning w.id into v_item_id;
  return v_item_id;
end $$;

revoke all on function mint_mac_worker_token(text, text, text, text, uuid[]) from public, anon, authenticated;
grant execute on function mint_mac_worker_token(text, text, text, text, uuid[]) to service_role;
revoke all on function revoke_mac_worker_token(uuid) from public, anon, authenticated;
grant execute on function revoke_mac_worker_token(uuid) to service_role;
revoke all on function mac_worker_can_access(uuid, uuid) from public, anon, authenticated;
grant execute on function mac_worker_can_access(uuid, uuid) to service_role;
revoke all on function claim_local_run_terminal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function claim_local_run_terminal(uuid, uuid, text) to service_role;
