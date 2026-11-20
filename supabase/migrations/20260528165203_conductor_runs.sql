
begin;

create table if not exists conductor_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  objective   text not null,
  goal_graph  jsonb not null default '[]'::jsonb,
  status      text not null default 'active'
                check (status in ('active', 'halted', 'done', 'failed')),
  spend_usd   numeric not null default 0,
  max_usd     numeric,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists conductor_runs_tenant_idx
  on conductor_runs (tenant_id, created_at desc);

alter table conductor_runs enable row level security;
drop policy if exists conductor_runs_select on conductor_runs;
create policy conductor_runs_select on conductor_runs
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = conductor_runs.tenant_id)
  );

create or replace function consume_conductor_budget_or_reject(
  p_conductor_run_id uuid,
  p_estimate_usd     numeric
) returns text
language plpgsql security definer set search_path = public as $$
declare v_updated uuid;
begin
  if p_conductor_run_id is null or p_estimate_usd is null or p_estimate_usd < 0 then
    raise exception 'consume_conductor_budget_or_reject: null/invalid argument'
      using errcode = '22023';
  end if;

  update conductor_runs
     set spend_usd = spend_usd + p_estimate_usd,
         updated_at = now()
   where id = p_conductor_run_id
     and status not in ('halted', 'done', 'failed')
     and (max_usd is null or spend_usd + p_estimate_usd <= max_usd)
  returning id into v_updated;

  if v_updated is not null then
    return 'charged';
  end if;

  update conductor_runs
     set status = 'halted', updated_at = now()
   where id = p_conductor_run_id
     and status not in ('halted', 'done', 'failed');

  return 'over_cap';
end;
$$;

revoke all on function consume_conductor_budget_or_reject(uuid, numeric) from public;
grant execute on function consume_conductor_budget_or_reject(uuid, numeric) to service_role;

commit;
