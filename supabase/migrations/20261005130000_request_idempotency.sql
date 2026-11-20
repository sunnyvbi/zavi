
create table public.request_idempotency (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  route text not null,
  idem_key text not null,
  request_hash text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'done')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, user_id, route, idem_key)
);

alter table public.request_idempotency enable row level security;
revoke all on public.request_idempotency from public, anon, authenticated;
grant select, insert, update, delete on public.request_idempotency to service_role;
