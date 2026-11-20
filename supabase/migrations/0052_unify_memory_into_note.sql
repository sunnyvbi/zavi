

alter table memory_note add column slug text;

create unique index memory_note_tenant_slug_active_uq
  on memory_note (tenant_id, slug)
  where slug is not null and superseded_by is null;

alter table memory_note drop constraint if exists memory_note_note_type_check;
alter table memory_note add constraint memory_note_note_type_check
  check (note_type in (
    'operator_preference',
    'agent_feedback',
    'tenant_project',
    'tenant_reference',
    'untyped',
    'anchor'
  ));

alter table memory_note add constraint memory_note_slug_anchor_invariant
  check ((slug is not null) = (note_type = 'anchor'));

create or replace function memory_note_upsert_anchor(
  p_tenant_id uuid,
  p_slug text,
  p_title text,
  p_body_markdown text,
  p_source text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  if p_slug is null or p_slug = '' then
    raise exception 'slug required for anchor upsert' using errcode = '22023';
  end if;

  insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type)
  values (p_tenant_id, p_slug, coalesce(p_title, p_slug || '.md'),
          coalesce(p_body_markdown, ''), coalesce(p_source, 'human'), 'anchor')
  on conflict (tenant_id, slug) where slug is not null and superseded_by is null
  do update set
    body_markdown = excluded.body_markdown,
    title = excluded.title,
    updated_at = now()
  returning id into v_id;

  delete from memory_chunk where note_id = v_id;

  return v_id;
end $$;
revoke all on function memory_note_upsert_anchor(uuid, text, text, text, text) from public;
grant execute on function memory_note_upsert_anchor(uuid, text, text, text, text) to authenticated, service_role;

create or replace function memory_note_upsert(
  p_tenant_id uuid,
  p_id uuid,
  p_title text,
  p_body_markdown text,
  p_source text,
  p_source_ref text,
  p_tags text[]
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_existing_slug text;
begin
  perform _assert_tenant_member(p_tenant_id);

  if p_id is not null then
    select slug into v_existing_slug from memory_note where id = p_id and tenant_id = p_tenant_id;
    if v_existing_slug is not null then
      raise exception 'cannot update anchor % via memory_note_upsert; use memory_note_upsert_anchor', p_id using errcode = '22023';
    end if;
  end if;

  if p_id is null then
    insert into memory_note (tenant_id, title, body_markdown, source, source_ref, tags)
      values (p_tenant_id, coalesce(p_title, ''), coalesce(p_body_markdown, ''),
              coalesce(p_source, 'human'), p_source_ref, coalesce(p_tags, array[]::text[]))
      returning id into v_id;
  else
    update memory_note set
      title = coalesce(p_title, title),
      body_markdown = coalesce(p_body_markdown, body_markdown),
      source = coalesce(p_source, source),
      source_ref = coalesce(p_source_ref, source_ref),
      tags = coalesce(p_tags, tags),
      updated_at = now()
    where id = p_id and tenant_id = p_tenant_id
    returning id into v_id;
    if v_id is null then
      raise exception 'memory_note % not found in tenant %', p_id, p_tenant_id;
    end if;
    delete from memory_chunk where note_id = v_id;
  end if;
  return v_id;
end $$;

create or replace function memory_note_delete(
  p_tenant_id uuid,
  p_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare v_slug text;
begin
  perform _assert_tenant_member(p_tenant_id);
  select slug into v_slug from memory_note where id = p_id and tenant_id = p_tenant_id;
  if v_slug is not null then
    raise exception 'cannot delete anchor (slug=%); anchors are rewritable, not deletable', v_slug using errcode = '22023';
  end if;
  delete from memory_note where id = p_id and tenant_id = p_tenant_id;
end $$;

insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type)
select tenant_id, slug, slug || '.md', body_markdown, 'human', 'anchor'
from memory_docs;

with candidates as (
  select id, tenant_id, body_markdown,
         row_number() over (
           partition by tenant_id
           order by (source = 'auto_distill_chat') desc, created_at asc
         ) as rn
  from memory_note
  where slug is null
    and lower(title) like 'company%'
    and note_type = 'untyped'
    and tenant_id not in (select tenant_id from memory_docs where slug = 'company')
)
insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type)
select tenant_id, 'company', 'company.md', body_markdown, 'human', 'anchor'
from candidates where rn = 1;

create or replace function activate_tenant_admin(
  p_user_id uuid,
  p_slug text,
  p_display_name text,
  p_rar numeric,
  p_memory jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_existing_owner uuid;
  v_memory_key text;
  v_memory_body text;
begin
  if p_user_id is null then
    raise exception 'p_user_id required' using errcode = '22023';
  end if;

  select id into v_tenant_id from tenants where slug = p_slug;

  if v_tenant_id is not null then
    select user_id into v_existing_owner
    from tenant_users
    where tenant_id = v_tenant_id and user_id = p_user_id;
    if v_existing_owner is null then
      raise exception 'tenant slug % is taken by another user; pick a different slug', p_slug
        using errcode = '23505';
    end if;
  else
    insert into tenants (slug, display_name, rar_weekly_threshold)
    values (p_slug, p_display_name, p_rar)
    returning id into v_tenant_id;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (p_user_id, v_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (p_user_id, v_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  for v_memory_key, v_memory_body in
    select * from jsonb_each_text(p_memory)
  loop
    perform memory_note_upsert_anchor(
      v_tenant_id,
      v_memory_key,
      v_memory_key || '.md',
      v_memory_body,
      'human'
    );
  end loop;

  return v_tenant_id;
end $$;
revoke all on function activate_tenant_admin(uuid, text, text, numeric, jsonb) from public;
grant execute on function activate_tenant_admin(uuid, text, text, numeric, jsonb) to service_role;

create or replace function activate_tenant(
  p_slug text,
  p_display_name text,
  p_rar numeric,
  p_memory jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return activate_tenant_admin(auth.uid(), p_slug, p_display_name, p_rar, p_memory);
end $$;
revoke all on function activate_tenant(text, text, numeric, jsonb) from public;
grant execute on function activate_tenant(text, text, numeric, jsonb) to authenticated;

create table distill_budget_ledger (
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (tenant_id, day)
);
alter table distill_budget_ledger enable row level security;

create table tenant_provisioning (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check (status in ('pending', 'ready', 'failed')),
  tenant_id uuid references tenants(id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  failure_reason text
);
alter table tenant_provisioning enable row level security;
create policy tenant_provisioning_self_select on tenant_provisioning
  for select using (user_id = auth.uid());

create or replace function apply_extracted_artifact(p_artifact_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_artifact extracted_artifacts;
  v_tenant uuid;
  v_user uuid := auth.uid();
  v_proposed jsonb;
  v_next_version int;
begin
  if v_user is null then
    raise exception 'must be authenticated' using errcode = '42501';
  end if;

  select * into v_artifact from extracted_artifacts where id = p_artifact_id for update;
  if v_artifact is null then
    raise exception 'artifact % not found', p_artifact_id using errcode = 'P0002';
  end if;
  if v_artifact.status <> 'proposed' then
    raise exception 'artifact % already %', p_artifact_id, v_artifact.status using errcode = '22023';
  end if;

  v_tenant := v_artifact.tenant_id;
  if not exists (select 1 from tenant_users where user_id = v_user and tenant_id = v_tenant) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;

  v_proposed := v_artifact.proposed;

  if v_artifact.kind = 'memory_update' then
    perform memory_note_upsert_anchor(
      v_tenant,
      v_artifact.target_slug,
      v_artifact.target_slug || '.md',
      v_proposed->>'proposed_body',
      'human'
    );

  elsif v_artifact.kind = 'skill_patch' then
    select coalesce(max(version), 0) + 1 into v_next_version
    from tenant_agents
    where tenant_id = v_tenant and slug = v_artifact.target_slug;

    insert into tenant_agents (tenant_id, slug, version, status, body_markdown, frontmatter, parent_version, created_by)
    values (
      v_tenant,
      v_artifact.target_slug,
      v_next_version,
      'draft',
      v_proposed->>'proposed_body',
      coalesce(v_proposed->'frontmatter', '{}'::jsonb),
      (v_proposed->>'parent_version')::int,
      v_user
    );

  elsif v_artifact.kind = 'new_agent_draft' then
    insert into tenant_agents (tenant_id, slug, version, status, body_markdown, frontmatter, parent_version, created_by)
    values (
      v_tenant,
      v_artifact.target_slug,
      1,
      'draft',
      v_proposed->>'agent_md_body',
      coalesce(v_proposed->'frontmatter', '{}'::jsonb),
      null,
      v_user
    );
  end if;

  update extracted_artifacts
  set status = 'applied',
      reviewed_by = v_user,
      reviewed_at = now(),
      applied_at = now(),
      apply_error = null
  where id = p_artifact_id;
end $$;

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
  v_anchor_id uuid;
  v_existing_anchor uuid;
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
    select id into v_existing_anchor
    from memory_note
    where tenant_id = p_tenant_id and slug = v_memory_key and superseded_by is null;
    if v_existing_anchor is null then
      v_anchor_id := memory_note_upsert_anchor(
        p_tenant_id,
        v_memory_key,
        v_memory_key || '.md',
        v_memory_body,
        'human'
      );
      v_seeds_inserted := v_seeds_inserted + 1;
    end if;
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
      v_agent->>'body_markdown',
      coalesce(v_agent->'frontmatter', '{}'::jsonb)
    )
    on conflict (tenant_id, slug, version) do nothing;
  end loop;

  insert into activation_idempotency (tenant_id, idempotency_key, result)
  values (
    p_tenant_id,
    p_idempotency_key,
    jsonb_build_object(
      'tenant_pack_id', v_tenant_pack_id,
      'activated_with_hash', v_pack.content_hash,
      'seeds_inserted', v_seeds_inserted
    )
  );

  return jsonb_build_object(
    'tenant_pack_id', v_tenant_pack_id,
    'activated_with_hash', v_pack.content_hash,
    'seeds_inserted', v_seeds_inserted
  );
end $$;

drop table memory_docs;
