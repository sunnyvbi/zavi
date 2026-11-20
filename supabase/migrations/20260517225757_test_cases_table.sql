
create table if not exists public.test_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  role text not null check (role in ('guest','host','public')),
  nl_spec jsonb not null,
  cached_playwright text,
  tags text[] not null default '{}'::text[],
  status text not null default 'active'
    check (status in ('active','muted','archived')),
  last_run_at timestamptz,
  last_status text check (last_status in ('passed','failed','healed','errored')),
  consecutive_red int not null default 0,
  last_healed_at timestamptz,
  created_by text not null check (created_by in ('agent-onboarding','operator-chat')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists test_cases_tenant_status_idx
  on public.test_cases (tenant_id, status);

alter table public.test_cases enable row level security;

drop policy if exists test_cases_member_select on public.test_cases;
drop policy if exists test_cases_member_insert on public.test_cases;
drop policy if exists test_cases_member_update on public.test_cases;
drop trigger if exists test_cases_set_updated_at on public.test_cases;
drop trigger if exists test_cases_lock_tenant_id on public.test_cases;

create policy test_cases_member_select on public.test_cases
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
    )
  );

create policy test_cases_member_insert on public.test_cases
  for insert with check (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
    )
  );

create policy test_cases_member_update on public.test_cases
  for update using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
    )
  )
  with check (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
    )
  );

create or replace function public.assert_test_cases_tenant_id_immutable()
returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'test_cases.tenant_id is immutable (old=% new=%)', old.tenant_id, new.tenant_id;
  end if;
  return new;
end;
$$;

create trigger test_cases_lock_tenant_id
  before update on public.test_cases
  for each row execute function public.assert_test_cases_tenant_id_immutable();

create or replace function public.touch_test_cases_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger test_cases_set_updated_at
  before update on public.test_cases
  for each row execute function public.touch_test_cases_updated_at();
