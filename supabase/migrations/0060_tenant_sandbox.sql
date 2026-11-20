
create table if not exists public.tenant_sandbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  repo_full_name  text not null,
  e2b_sandbox_id  text,
  status          text not null check (status in ('creating','active','paused','destroyed','failed')),
  last_resumed_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, repo_full_name)
);

alter table public.tenant_sandbox enable row level security;

create or replace function get_or_create_tenant_sandbox(
  p_tenant_id uuid,
  p_repo_full_name text
) returns public.tenant_sandbox
language plpgsql security definer set search_path = public as $$
declare v_row public.tenant_sandbox;
begin
  select * into v_row
  from public.tenant_sandbox
  where tenant_id = p_tenant_id and repo_full_name = p_repo_full_name;

  if found then
    return v_row;
  end if;

  insert into public.tenant_sandbox (tenant_id, repo_full_name, status)
  values (p_tenant_id, p_repo_full_name, 'creating')
  returning * into v_row;

  return v_row;
end $$;
revoke all on function get_or_create_tenant_sandbox(uuid, text) from public;

create or replace function mark_sandbox_active(
  p_id uuid,
  p_e2b_sandbox_id text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set status         = 'active',
      e2b_sandbox_id = p_e2b_sandbox_id,
      last_resumed_at = now(),
      last_error     = null,
      updated_at     = now()
  where id = p_id;
end $$;
revoke all on function mark_sandbox_active(uuid, text) from public;

create or replace function mark_sandbox_paused(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set status = 'paused', updated_at = now()
  where id = p_id;
end $$;
revoke all on function mark_sandbox_paused(uuid) from public;

create or replace function mark_sandbox_destroyed(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set status         = 'destroyed',
      e2b_sandbox_id = null,
      updated_at     = now()
  where id = p_id;
end $$;
revoke all on function mark_sandbox_destroyed(uuid) from public;

create or replace function mark_sandbox_failed(
  p_id uuid,
  p_error text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
  set status     = 'failed',
      last_error = left(coalesce(p_error, ''), 1000),
      updated_at = now()
  where id = p_id;
end $$;
revoke all on function mark_sandbox_failed(uuid, text) from public;
