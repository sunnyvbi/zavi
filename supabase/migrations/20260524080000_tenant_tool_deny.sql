
create table if not exists public.tenant_tool_deny (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agent_slug text not null default '',
  tool_name text not null,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (tenant_id, agent_slug, tool_name)
);

create index if not exists tenant_tool_deny_lookup_idx
  on public.tenant_tool_deny(tenant_id, tool_name, agent_slug);

alter table public.tenant_tool_deny enable row level security;

create policy "tenant_tool_deny_service_only"
  on public.tenant_tool_deny
  as permissive
  for all
  to service_role
  using (true)
  with check (true);
