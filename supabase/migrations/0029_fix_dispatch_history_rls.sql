
alter table public.dispatch_history disable row level security;
drop policy if exists dispatch_history_tenant_read on public.dispatch_history;
alter table public.dispatch_history enable row level security;

create policy dispatch_history_tenant_read
  on public.dispatch_history
  for select
  using (
    tenant_id in (
      select tenant_id from public.tenant_users where user_id = auth.uid()
    )
  );

comment on policy dispatch_history_tenant_read on public.dispatch_history is
  'Tenant members read their own dispatch_history rows. Service-role bypasses (used by post-run hooks for INSERT + dedup). Fixed in 0029 from a 0028 typo (tenant_memberships → tenant_users).';
