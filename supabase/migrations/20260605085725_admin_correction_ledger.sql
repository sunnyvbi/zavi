
create table if not exists admin_correction_ledger (
  id             bigint      generated always as identity primary key,
  tenant_id      uuid        not null,
  agent_slug     text        not null,
  signature      text        not null,
  decision_id    uuid        not null,
  decision_class text        not null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, decision_id)
);

create index if not exists admin_correction_ledger_sig_idx
  on admin_correction_ledger (tenant_id, agent_slug, signature);

create index if not exists admin_correction_ledger_xtenant_idx
  on admin_correction_ledger (signature);

alter table admin_correction_ledger enable row level security;

create or replace function record_admin_correction(
  p_tenant_id      uuid,
  p_agent_slug     text,
  p_signature      text,
  p_decision_id    uuid,
  p_decision_class text
) returns table (occurrence_count bigint, inserted boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_decision_tenant uuid;
  v_inserted        bigint := 0;
  v_count           bigint;
begin
  if p_tenant_id is null then
    raise exception 'record_admin_correction: null tenant_id' using errcode = '22023';
  end if;
  if p_decision_id is null then
    raise exception 'record_admin_correction: null decision_id' using errcode = '22023';
  end if;
  if p_signature is null or char_length(p_signature) < 8 then
    raise exception 'record_admin_correction: bad signature' using errcode = '22023';
  end if;
  if p_agent_slug is null or char_length(p_agent_slug) < 1 then
    raise exception 'record_admin_correction: empty agent_slug' using errcode = '22023';
  end if;

  select tenant_id into v_decision_tenant from decisions where id = p_decision_id;
  if v_decision_tenant is null then
    raise exception 'record_admin_correction: decision % not found', p_decision_id
      using errcode = '22023';
  end if;
  if v_decision_tenant <> p_tenant_id then
    raise exception 'record_admin_correction: decision % does not belong to tenant %',
      p_decision_id, p_tenant_id using errcode = '42501';
  end if;

  insert into admin_correction_ledger (
    tenant_id, agent_slug, signature, decision_id, decision_class
  ) values (
    p_tenant_id, p_agent_slug, p_signature, p_decision_id, p_decision_class
  )
  on conflict (tenant_id, decision_id) do nothing;
  get diagnostics v_inserted = row_count;

  select count(*) into v_count
    from admin_correction_ledger
   where tenant_id = p_tenant_id
     and agent_slug = p_agent_slug
     and signature = p_signature;

  return query select v_count, (v_inserted = 1);
end $$;
revoke all on function record_admin_correction(uuid, text, text, uuid, text) from public;
revoke all on function record_admin_correction(uuid, text, text, uuid, text) from authenticated;
grant execute on function record_admin_correction(uuid, text, text, uuid, text) to service_role;

create or replace function count_admin_correction_tenants(
  p_signature text
) returns bigint
language sql security definer set search_path = public as $$
  select count(distinct tenant_id)
    from admin_correction_ledger
   where signature = p_signature;
$$;
revoke all on function count_admin_correction_tenants(text) from public;
revoke all on function count_admin_correction_tenants(text) from authenticated;
grant execute on function count_admin_correction_tenants(text) to service_role;

create or replace function lookup_correction_signature(
  p_decision_id uuid
) returns text
language sql security definer set search_path = public as $$
  select signature
    from admin_correction_ledger
   where decision_id = p_decision_id
   limit 1;
$$;
revoke all on function lookup_correction_signature(uuid) from public;
revoke all on function lookup_correction_signature(uuid) from authenticated;
grant execute on function lookup_correction_signature(uuid) to service_role;

create table if not exists admin_correction_bake_claims (
  tenant_id   uuid        not null,
  agent_slug  text        not null,
  signature   text        not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, agent_slug, signature)
);

alter table admin_correction_bake_claims enable row level security;

create or replace function claim_admin_correction_bake(
  p_tenant_id  uuid,
  p_agent_slug text,
  p_signature  text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_claimed bigint;
begin
  if p_tenant_id is null then
    raise exception 'claim_admin_correction_bake: null tenant_id' using errcode = '22023';
  end if;
  if p_signature is null or char_length(p_signature) < 8 then
    raise exception 'claim_admin_correction_bake: bad signature' using errcode = '22023';
  end if;

  insert into admin_correction_bake_claims (tenant_id, agent_slug, signature)
  values (p_tenant_id, p_agent_slug, p_signature)
  on conflict (tenant_id, agent_slug, signature) do nothing;
  get diagnostics v_claimed = row_count;

  return (v_claimed = 1);
end $$;
revoke all on function claim_admin_correction_bake(uuid, text, text) from public;
revoke all on function claim_admin_correction_bake(uuid, text, text) from authenticated;
grant execute on function claim_admin_correction_bake(uuid, text, text) to service_role;
