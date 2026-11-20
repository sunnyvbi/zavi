
create extension if not exists pgcrypto;

create table if not exists public.delegation_lineage (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  lineage_id        uuid not null,
  depth             int  not null check (depth >= 1),
  parent_run_id     uuid,
  child_run_id      uuid,
  source_agent_slug text not null,
  target_agent_slug text not null,
  created_at        timestamptz not null default now()
);

create index if not exists delegation_lineage_tree_idx
  on public.delegation_lineage (tenant_id, lineage_id, created_at desc);

create index if not exists delegation_lineage_child_run_idx
  on public.delegation_lineage (tenant_id, child_run_id)
  where child_run_id is not null;

alter table public.delegation_lineage enable row level security;

create policy delegation_lineage_tenant_read
  on public.delegation_lineage
  for select
  using (
    tenant_id in (
      select tenant_id from public.tenant_users where user_id = auth.uid()
    )
  );

comment on table public.delegation_lineage is
  'Global delegation-tree ledger for the loop/depth/cost circuit breaker '
  '(Gap 2). One row per parent_run->child_run edge; lineage_id groups one '
  'request tree; depth + the set of target slugs gate MAX_DELEGATION_DEPTH '
  'and cycle detection; cumulative cost rolls up via the run cost join.';

create or replace function lineage_tree_stats(
  p_tenant_id  uuid,
  p_lineage_id uuid
) returns table (
  max_depth       int,
  target_slugs    text[],
  cumulative_cost numeric
)
language sql
security definer
set search_path = public
as $$
  with edges as (
    select depth, parent_run_id, child_run_id, target_agent_slug
      from public.delegation_lineage
     where tenant_id = p_tenant_id
       and lineage_id = p_lineage_id
  ),
  run_ids as (
    select parent_run_id as run_id from edges where parent_run_id is not null
    union
    select child_run_id as run_id from edges where child_run_id is not null
  )
  select
    coalesce((select max(depth) from edges), 0)::int                  as max_depth,
    coalesce(
      (select array_agg(distinct target_agent_slug) from edges),
      array[]::text[]
    )                                                                 as target_slugs,
    coalesce(
      (select sum(ar.cost_usd)
         from agent_runs ar
         join run_ids r on r.run_id = ar.id
        where ar.tenant_id = p_tenant_id),
      0
    )::numeric                                                        as cumulative_cost;
$$;

revoke all on function lineage_tree_stats(uuid, uuid) from public;
grant execute on function lineage_tree_stats(uuid, uuid) to service_role;

comment on function lineage_tree_stats(uuid, uuid) is
  'Single-read stats for the delegation circuit breaker: max hop depth, the '
  'set of target slugs already in the lineage (cycle check), and cumulative '
  'cost summed once per distinct participating run. Fail-closed on the TS '
  'side when this errors (treat as over-limit).';
