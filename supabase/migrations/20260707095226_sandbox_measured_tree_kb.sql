
alter table public.tenant_sandbox
  add column if not exists measured_tree_kb bigint;

comment on column public.tenant_sandbox.measured_tree_kb is
  'Last measured working-tree size (KB) of this repo checkout, from run-worktree preflight. Drives sandbox-tier selection; NULL = never measured (use default template). git object-size lies — this is the real checkout footprint.';

alter table public.tenant_sandbox
  add column if not exists e2b_template text;

comment on column public.tenant_sandbox.e2b_template is
  'The e2b template alias this sandbox was created on (NULL = legacy/unknown → treated as the default tier). The tier-up guard reads this, NOT measured_tree_kb, to decide whether a bigger tier is actually available.';

create or replace function public.set_sandbox_measured_tree_kb(
  p_tenant_id uuid,
  p_repo_full_name text,
  p_kb bigint
) returns void
language sql
security definer
set search_path = public
as $$
  update public.tenant_sandbox
     set measured_tree_kb = p_kb,
         updated_at = now()
   where tenant_id = p_tenant_id
     and repo_full_name = p_repo_full_name;
$$;

create or replace function public.set_sandbox_template(
  p_id uuid,
  p_template text
) returns void
language sql
security definer
set search_path = public
as $$
  update public.tenant_sandbox
     set e2b_template = p_template,
         updated_at = now()
   where id = p_id;
$$;

revoke all on function public.set_sandbox_measured_tree_kb(uuid, text, bigint) from public;
grant execute on function public.set_sandbox_measured_tree_kb(uuid, text, bigint) to service_role;
revoke all on function public.set_sandbox_template(uuid, text) from public;
grant execute on function public.set_sandbox_template(uuid, text) to service_role;
