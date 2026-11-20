
create table if not exists fundraising_round_config (
  tenant_id              uuid        primary key references tenants(id) on delete cascade,
  ask                    text,
  instrument             text,
  thesis                 text,
  proof                  text,
  updated_by             uuid        references auth.users(id) on delete set null,
  updated_at             timestamptz not null default now(),
  last_run_requested_at  timestamptz,
  last_run_requested_by  uuid        references auth.users(id) on delete set null
);

alter table fundraising_round_config enable row level security;

create policy fundraising_round_config_select on fundraising_round_config
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = fundraising_round_config.tenant_id)
  );

create or replace function fundraising_set_round_config(
  p_tenant_id  uuid,
  p_ask        text,
  p_instrument text,
  p_thesis     text,
  p_proof      text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_round_config: tenant_id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_round_config (tenant_id, ask, instrument, thesis, proof, updated_by, updated_at)
  values (p_tenant_id, p_ask, p_instrument, p_thesis, p_proof, auth.uid(), now())
  on conflict (tenant_id) do update set
    ask        = excluded.ask,
    instrument = excluded.instrument,
    thesis     = excluded.thesis,
    proof      = excluded.proof,
    updated_by = excluded.updated_by,
    updated_at = now();
end $$;

revoke all on function fundraising_set_round_config(uuid, text, text, text, text) from public;
grant execute on function fundraising_set_round_config(uuid, text, text, text, text) to authenticated;
grant execute on function fundraising_set_round_config(uuid, text, text, text, text) to service_role;

create or replace function fundraising_mark_round_requested(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_mark_round_requested: tenant_id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_round_config (tenant_id, last_run_requested_at, last_run_requested_by, updated_at)
  values (p_tenant_id, now(), auth.uid(), now())
  on conflict (tenant_id) do update set
    last_run_requested_at = now(),
    last_run_requested_by = auth.uid();
end $$;

revoke all on function fundraising_mark_round_requested(uuid) from public;
grant execute on function fundraising_mark_round_requested(uuid) to authenticated;
grant execute on function fundraising_mark_round_requested(uuid) to service_role;
