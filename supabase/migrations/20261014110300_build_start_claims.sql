begin;

create table if not exists public.build_start_claims (
  user_id          uuid not null,
  idem_key         text not null check (length(idem_key) between 8 and 200),
  tenant_id        uuid references public.tenants(id) on delete cascade,
  conductor_run_id uuid,
  created_at       timestamptz not null default now(),
  primary key (user_id, idem_key)
);

alter table public.build_start_claims enable row level security;
revoke all on public.build_start_claims from public, anon, authenticated;
grant select, insert, update, delete on public.build_start_claims to service_role;

commit;
