
create table tenant_commands (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  slug            text not null check (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  name            text not null check (length(name) between 1 and 80),
  description     text not null default '' check (length(description) <= 200),
  instructions_md text not null default '' check (length(instructions_md) <= 8000),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, slug)
);

alter table tenant_commands
  add constraint tenant_commands_slug_not_reserved
  check (slug not in ('feedback','clear','help','run','decision'));

alter table tenant_commands enable row level security;

create policy tenant_commands_member_select on tenant_commands
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = tenant_commands.tenant_id
    )
  );

create or replace function list_tenant_commands()
returns setof tenant_commands
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then return; end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    return;
  end if;
  return query
    select * from tenant_commands
    where tenant_id = v_tenant
    order by slug;
end $$;

create or replace function upsert_tenant_command(
  p_slug text,
  p_name text,
  p_description text,
  p_instructions_md text
) returns tenant_commands
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row tenant_commands;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;

  insert into tenant_commands (
    tenant_id, slug, name, description, instructions_md, created_by
  )
  values (
    v_tenant,
    lower(p_slug),
    p_name,
    coalesce(p_description, ''),
    coalesce(p_instructions_md, ''),
    auth.uid()
  )
  on conflict (tenant_id, slug) do update
    set name = excluded.name,
        description = excluded.description,
        instructions_md = excluded.instructions_md,
        updated_at = now()
  returning * into v_row;

  return v_row;
end $$;

create or replace function delete_tenant_command(p_slug text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  delete from tenant_commands
    where tenant_id = v_tenant and slug = lower(p_slug);
end $$;

revoke all on function list_tenant_commands() from public;
revoke all on function upsert_tenant_command(text, text, text, text) from public;
revoke all on function delete_tenant_command(text) from public;
grant execute on function list_tenant_commands() to authenticated;
grant execute on function upsert_tenant_command(text, text, text, text) to authenticated;
grant execute on function delete_tenant_command(text) to authenticated;
