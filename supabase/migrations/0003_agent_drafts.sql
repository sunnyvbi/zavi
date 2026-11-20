
create table agent_drafts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text not null,
  name text not null,
  description text default '',
  model text not null,
  cost_class text not null,
  sla_class text,
  cron text default '',
  impact_classes text[] default array[]::text[],
  instructions text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  primary key (tenant_id, slug)
);

alter table agent_drafts enable row level security;

create policy agent_drafts_member_select on agent_drafts
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = agent_drafts.tenant_id
    )
  );

create or replace function create_agent_draft(
  p_tenant_id uuid,
  p_slug text,
  p_name text,
  p_description text,
  p_model text,
  p_cost_class text,
  p_sla_class text,
  p_cron text,
  p_impact_classes text[],
  p_instructions text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;

  insert into agent_drafts (
    tenant_id, slug, name, description, model, cost_class,
    sla_class, cron, impact_classes, instructions, created_by
  )
  values (
    p_tenant_id, p_slug, p_name, p_description, p_model, p_cost_class,
    p_sla_class, p_cron, p_impact_classes, p_instructions, auth.uid()
  )
  on conflict (tenant_id, slug) do nothing;
end $$;
revoke all on function create_agent_draft(uuid, text, text, text, text, text, text, text, text[], text) from public;
grant execute on function create_agent_draft(uuid, text, text, text, text, text, text, text, text[], text) to authenticated;
