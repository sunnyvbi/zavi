
begin;

create table if not exists cgo_wake_skips (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  wake_reason  text not null check (char_length(wake_reason) <= 60),
  why          text not null check (char_length(why) <= 120),
  created_at   timestamptz not null default now()
);

create index if not exists cgo_wake_skips_tenant_created_idx on cgo_wake_skips (tenant_id, created_at desc);

alter table cgo_wake_skips enable row level security;

create policy cgo_wake_skips_member_select on cgo_wake_skips
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = cgo_wake_skips.tenant_id
    )
  );
create policy cgo_wake_skips_active_tenant_restrict
  on cgo_wake_skips as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));
revoke all on public.cgo_wake_skips from public, anon, authenticated;
grant select on public.cgo_wake_skips to authenticated;

commit;
