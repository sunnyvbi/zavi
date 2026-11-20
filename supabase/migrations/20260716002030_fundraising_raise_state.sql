
create table if not exists fundraising_raise (
  tenant_id             uuid        primary key references tenants(id) on delete cascade,
  current_phase         text        not null default 'prep'
                          check (current_phase in ('prep','warmup','outreach','meetings','close')),
  readiness_snapshot    jsonb,
  round_design_snapshot jsonb,
  last_advice_run_id    uuid,
  phase_entered_at      timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table fundraising_raise enable row level security;

create policy fundraising_raise_select on fundraising_raise
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = fundraising_raise.tenant_id)
  );

create or replace function fundraising_set_raise_phase(
  p_tenant_id uuid,
  p_phase     text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_raise_phase: tenant_id required' using errcode = '22023';
  end if;
  if p_phase is null or p_phase not in ('prep','warmup','outreach','meetings','close') then
    raise exception 'fundraising_set_raise_phase: invalid phase %', p_phase using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_raise (tenant_id, current_phase, phase_entered_at, updated_at)
  values (p_tenant_id, p_phase, now(), now())
  on conflict (tenant_id) do update set
    current_phase    = excluded.current_phase,
    phase_entered_at = now(),
    updated_at       = now();
end $$;

revoke all on function fundraising_set_raise_phase(uuid, text) from public;
grant execute on function fundraising_set_raise_phase(uuid, text) to authenticated;
grant execute on function fundraising_set_raise_phase(uuid, text) to service_role;

create or replace function fundraising_set_raise_snapshot(
  p_tenant_id     uuid,
  p_readiness     jsonb,
  p_round_design  jsonb,
  p_run_id        uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_raise_snapshot: tenant_id required' using errcode = '22023';
  end if;

  insert into fundraising_raise (tenant_id, readiness_snapshot, round_design_snapshot,
                                 last_advice_run_id, updated_at)
  values (p_tenant_id, p_readiness, p_round_design, p_run_id, now())
  on conflict (tenant_id) do update set
    readiness_snapshot    = coalesce(excluded.readiness_snapshot,    fundraising_raise.readiness_snapshot),
    round_design_snapshot = coalesce(excluded.round_design_snapshot, fundraising_raise.round_design_snapshot),
    last_advice_run_id    = coalesce(excluded.last_advice_run_id,    fundraising_raise.last_advice_run_id),
    updated_at            = now();
end $$;

revoke all on function fundraising_set_raise_snapshot(uuid, jsonb, jsonb, uuid) from public;
revoke execute on function fundraising_set_raise_snapshot(uuid, jsonb, jsonb, uuid) from authenticated;
grant execute on function fundraising_set_raise_snapshot(uuid, jsonb, jsonb, uuid) to service_role;
