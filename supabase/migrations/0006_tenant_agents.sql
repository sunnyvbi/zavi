
create type tenant_agent_status as enum ('draft', 'active', 'retired');

create table tenant_agents (
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text not null,
  version int not null,
  body_markdown text not null,
  frontmatter jsonb not null default '{}'::jsonb,
  parent_version int,
  parent_template text,
  status tenant_agent_status not null default 'draft',
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  primary key (tenant_id, slug, version)
);

create index tenant_agents_active on tenant_agents (tenant_id, slug)
  where status = 'active';

alter table tenant_agents enable row level security;

create policy tenant_agents_member_select on tenant_agents
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_agents.tenant_id
    )
  );

create or replace function fork_agent_template(
  p_tenant_id uuid,
  p_slug text,
  p_body_markdown text,
  p_frontmatter jsonb,
  p_parent_template text
) returns int
language plpgsql security definer set search_path = public as $$
declare v_version int;
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

  select max(version) into v_version
  from tenant_agents
  where tenant_id = p_tenant_id and slug = p_slug;
  if v_version is not null then
    return v_version;
  end if;

  insert into tenant_agents (
    tenant_id, slug, version, body_markdown, frontmatter,
    parent_version, parent_template, status, created_by
  ) values (
    p_tenant_id, p_slug, 1, p_body_markdown, p_frontmatter,
    null, p_parent_template, 'draft', auth.uid()
  );
  return 1;
end $$;
revoke all on function fork_agent_template(uuid, text, text, jsonb, text) from public;
grant execute on function fork_agent_template(uuid, text, text, jsonb, text) to authenticated;

create or replace function save_agent_version(
  p_tenant_id uuid,
  p_slug text,
  p_body_markdown text,
  p_frontmatter jsonb,
  p_status tenant_agent_status
) returns int
language plpgsql security definer set search_path = public as $$
declare v_prev int; v_new int;
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

  select max(version) into v_prev
  from tenant_agents
  where tenant_id = p_tenant_id and slug = p_slug;
  if v_prev is null then
    raise exception 'agent % not forked yet for tenant %', p_slug, p_tenant_id using errcode = 'P0002';
  end if;

  v_new := v_prev + 1;
  insert into tenant_agents (
    tenant_id, slug, version, body_markdown, frontmatter,
    parent_version, status, created_by
  ) values (
    p_tenant_id, p_slug, v_new, p_body_markdown, p_frontmatter,
    v_prev, p_status, auth.uid()
  );

  if p_status = 'active' then
    update tenant_agents
    set status = 'retired'
    where tenant_id = p_tenant_id and slug = p_slug
      and version != v_new and status = 'active';
  end if;

  return v_new;
end $$;
revoke all on function save_agent_version(uuid, text, text, jsonb, tenant_agent_status) from public;
grant execute on function save_agent_version(uuid, text, text, jsonb, tenant_agent_status) to authenticated;
