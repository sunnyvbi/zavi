
begin;

create table if not exists tenant_personalization (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  base_tone text not null default 'default'
    check (base_tone in ('default', 'concise', 'friendly', 'professional', 'direct')),
  warm boolean not null default false,
  enthusiastic boolean not null default false,
  headers_lists boolean not null default true,
  emoji boolean not null default false,
  custom_instructions text not null default ''
    check (char_length(custom_instructions) <= 4000),
  brand_voice text not null default ''
    check (char_length(brand_voice) <= 2000),
  response_rules text not null default ''
    check (char_length(response_rules) <= 2000),
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

comment on table tenant_personalization is
  'Per-tenant style + custom instructions rendered into every agent prompt (Personalization page).';

create table if not exists tenant_personalization_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null
);

create index if not exists tenant_personalization_history_tenant_version
  on tenant_personalization_history (tenant_id, version desc);

alter table tenant_personalization enable row level security;
alter table tenant_personalization_history enable row level security;

drop policy if exists tenant_personalization_member_select on tenant_personalization;
create policy tenant_personalization_member_select on tenant_personalization
  for select
  using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = tenant_personalization.tenant_id
        and tu.user_id = auth.uid()
    )
  );

drop policy if exists tenant_personalization_history_member_select on tenant_personalization_history;
create policy tenant_personalization_history_member_select on tenant_personalization_history
  for select
  using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = tenant_personalization_history.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on tenant_personalization from anon, authenticated;
revoke insert, update, delete on tenant_personalization_history from anon, authenticated;
grant select on tenant_personalization to authenticated;
grant select on tenant_personalization_history to authenticated;

create or replace function set_tenant_personalization(
  p_tenant_id uuid,
  p_patch jsonb,
  p_actor uuid default null
) returns tenant_personalization
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row tenant_personalization;
begin
  if p_tenant_id is null then
    raise exception 'tenant_id required' using errcode = '22023';
  end if;

  insert into tenant_personalization (tenant_id, updated_by, version)
  values (p_tenant_id, p_actor, 0)
  on conflict (tenant_id) do nothing;

  update tenant_personalization t
  set
    base_tone = coalesce(p_patch->>'base_tone', t.base_tone),
    warm = coalesce((p_patch->>'warm')::boolean, t.warm),
    enthusiastic = coalesce((p_patch->>'enthusiastic')::boolean, t.enthusiastic),
    headers_lists = coalesce((p_patch->>'headers_lists')::boolean, t.headers_lists),
    emoji = coalesce((p_patch->>'emoji')::boolean, t.emoji),
    custom_instructions = coalesce(p_patch->>'custom_instructions', t.custom_instructions),
    brand_voice = coalesce(p_patch->>'brand_voice', t.brand_voice),
    response_rules = coalesce(p_patch->>'response_rules', t.response_rules),
    version = t.version + 1,
    updated_at = now(),
    updated_by = p_actor
  where t.tenant_id = p_tenant_id
  returning * into v_row;

  insert into tenant_personalization_history (tenant_id, version, snapshot, changed_at, changed_by)
  values (p_tenant_id, v_row.version, to_jsonb(v_row), v_row.updated_at, p_actor);

  return v_row;
end $$;

revoke all on function set_tenant_personalization(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function set_tenant_personalization(uuid, jsonb, uuid) to service_role;

commit;
