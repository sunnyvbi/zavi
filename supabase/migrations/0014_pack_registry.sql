

create table packs (
  id text primary key,
  pack_slug text not null,
  semver text not null,
  status text not null check (status in ('preview', 'stable', 'retired')),
  display_name text not null,
  description text not null default '',
  supersedes text references packs(id),
  content jsonb not null,
  content_hash text not null,
  compiled_at timestamptz not null default now(),
  entity_types jsonb not null,
  outcome_classes jsonb not null,
  connector_map jsonb not null default '{}'::jsonb,
  seed_skills jsonb not null default '[]'::jsonb,
  seed_memory jsonb not null default '{}'::jsonb,
  seed_agent_drafts jsonb not null default '[]'::jsonb
);

create unique index packs_one_stable_per_slug on packs(pack_slug) where status = 'stable';
create index packs_slug_status on packs(pack_slug, status);

alter table packs enable row level security;
create policy packs_authenticated_read on packs
  for select to authenticated using (true);

create table tenant_packs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pack_id text not null references packs(id),
  activated_with_hash text not null,
  activated_at timestamptz not null default now(),
  unique (tenant_id, pack_id)
);

create index tenant_packs_tenant on tenant_packs(tenant_id);

alter table tenant_packs enable row level security;
create policy tenant_packs_member_select on tenant_packs
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = tenant_packs.tenant_id)
  );

create table entity_aliases (
  tenant_id uuid not null references tenants(id) on delete cascade,
  subject_id uuid not null default gen_random_uuid(),
  pack_id text not null references packs(id),
  entity_type text not null,
  external_id text not null,
  kind text not null default 'same_subject',
  confidence numeric not null default 1.0 check (confidence >= 0 and confidence <= 1),
  derived_by text not null default 'manual',
  created_at timestamptz default now(),
  primary key (tenant_id, pack_id, entity_type, external_id, kind)
);

create index entity_aliases_subject on entity_aliases(tenant_id, subject_id);

alter table entity_aliases enable row level security;
create policy entity_aliases_member_select on entity_aliases
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = entity_aliases.tenant_id)
  );

create table activation_idempotency (
  tenant_id uuid not null references tenants(id) on delete cascade,
  idempotency_key text not null,
  result jsonb not null,
  created_at timestamptz default now(),
  primary key (tenant_id, idempotency_key)
);

create index activation_idempotency_created on activation_idempotency(created_at);

alter table activation_idempotency enable row level security;
revoke all on activation_idempotency from public, authenticated, anon;

create or replace function activate_tenant_pack(
  p_tenant_id uuid,
  p_pack_id text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_pack packs%rowtype;
  v_tenant_pack_id uuid;
  v_seeds_inserted int := 0;
  v_memory_key text;
  v_memory_body text;
  v_agent jsonb;
begin
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'caller is not a member of tenant %', p_tenant_id;
  end if;

  select result into v_existing
    from activation_idempotency
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then return v_existing; end if;

  select * into v_pack from packs where id = p_pack_id;
  if v_pack.id is null then
    raise exception 'pack not found: %', p_pack_id;
  end if;
  if v_pack.status = 'retired' then
    raise exception 'pack is retired: %', p_pack_id;
  end if;

  insert into tenant_packs (tenant_id, pack_id, activated_with_hash)
    values (p_tenant_id, p_pack_id, v_pack.content_hash)
    on conflict (tenant_id, pack_id) do nothing
    returning id into v_tenant_pack_id;

  for v_memory_key, v_memory_body in
    select * from jsonb_each_text(v_pack.seed_memory)
  loop
    insert into memory_docs (tenant_id, slug, body_markdown)
      values (p_tenant_id, v_memory_key, v_memory_body)
      on conflict (tenant_id, slug) do nothing;
    if found then v_seeds_inserted := v_seeds_inserted + 1; end if;
  end loop;

  for v_agent in select * from jsonb_array_elements(v_pack.seed_agent_drafts)
  loop
    insert into tenant_agents (
      tenant_id, slug, version, status, body_markdown, frontmatter
    ) values (
      p_tenant_id,
      v_agent->>'slug',
      1,
      'draft',
      coalesce(v_agent->>'body_markdown', ''),
      coalesce(v_agent->'frontmatter', '{}'::jsonb)
    ) on conflict (tenant_id, slug, version) do nothing;
    if found then v_seeds_inserted := v_seeds_inserted + 1; end if;
  end loop;

  v_existing := jsonb_build_object(
    'tenant_pack_id', v_tenant_pack_id,
    'activated_with_hash', v_pack.content_hash,
    'seeds_inserted', v_seeds_inserted
  );
  insert into activation_idempotency (tenant_id, idempotency_key, result)
    values (p_tenant_id, p_idempotency_key, v_existing)
    on conflict (tenant_id, idempotency_key) do nothing;

  return v_existing;
end;
$$;

revoke all on function activate_tenant_pack(uuid, text, text) from public;
grant execute on function activate_tenant_pack(uuid, text, text) to authenticated;

create or replace function link_subject(
  p_tenant_id uuid,
  p_subject_id uuid,
  p_aliases jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subject uuid;
  v_alias jsonb;
begin
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'caller is not a member of tenant %', p_tenant_id;
  end if;

  v_subject := coalesce(p_subject_id, gen_random_uuid());

  for v_alias in select * from jsonb_array_elements(p_aliases)
  loop
    insert into entity_aliases (
      tenant_id, subject_id, pack_id, entity_type, external_id, kind, confidence, derived_by
    ) values (
      p_tenant_id,
      v_subject,
      v_alias->>'pack_id',
      v_alias->>'entity_type',
      v_alias->>'external_id',
      coalesce(v_alias->>'kind', 'same_subject'),
      coalesce((v_alias->>'confidence')::numeric, 1.0),
      coalesce(v_alias->>'derived_by', 'manual')
    ) on conflict (tenant_id, pack_id, entity_type, external_id, kind)
      do update set
        subject_id = excluded.subject_id,
        confidence = excluded.confidence,
        derived_by = excluded.derived_by;
  end loop;

  return v_subject;
end;
$$;

revoke all on function link_subject(uuid, uuid, jsonb) from public;
grant execute on function link_subject(uuid, uuid, jsonb) to authenticated;

create or replace function prune_activation_idempotency() returns int
language sql security definer set search_path = public as $$
  with deleted as (
    delete from activation_idempotency
    where created_at < now() - interval '24 hours'
    returning 1
  ) select count(*)::int from deleted;
$$;

revoke all on function prune_activation_idempotency() from public, authenticated, anon;
