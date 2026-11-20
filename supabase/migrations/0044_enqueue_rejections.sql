
create table enqueue_rejections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_slug text not null,
  rejection_reason text not null,
  body_fingerprint text,
  trigger text,
  created_at timestamptz not null default now()
);

create index enqueue_rejections_tenant_agent_idx
  on enqueue_rejections (tenant_id, agent_slug, created_at desc);

alter table enqueue_rejections enable row level security;

create policy enqueue_rejections_tenant_select on enqueue_rejections
  for select to authenticated using (
    exists (
      select 1 from tenant_users
      where tenant_users.tenant_id = enqueue_rejections.tenant_id
        and tenant_users.user_id = auth.uid()
    )
  );

revoke insert, update, delete on enqueue_rejections from authenticated, anon;
grant select on enqueue_rejections to authenticated;
grant all on enqueue_rejections to service_role;
