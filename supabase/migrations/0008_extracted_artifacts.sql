

create table ingested_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  external_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz default now(),
  distilled_at timestamptz,
  unique (provider, external_event_id)
);
create index ingested_events_tenant_received on ingested_events (tenant_id, received_at desc);
alter table ingested_events enable row level security;
create policy ingested_events_member_select on ingested_events
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = ingested_events.tenant_id)
  );

create type artifact_kind as enum ('memory_update', 'skill_patch', 'new_agent_draft');
create type artifact_status as enum ('proposed', 'applied', 'rejected');

create table extracted_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind artifact_kind not null,
  target_slug text not null,
  source_event_id uuid references ingested_events(id) on delete set null,
  source_window_start timestamptz,
  source_window_end timestamptz,
  rationale text not null default '',
  proposed jsonb not null,
  status artifact_status not null default 'proposed',
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  applied_at timestamptz,
  apply_error text,
  created_at timestamptz default now()
);
create index extracted_artifacts_tenant_status on extracted_artifacts (tenant_id, status, created_at desc);
alter table extracted_artifacts enable row level security;
create policy extracted_artifacts_member_select on extracted_artifacts
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = extracted_artifacts.tenant_id)
  );

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
    insert into memory_docs (tenant_id, slug, body_markdown)
    values (v_tenant, v_artifact.target_slug, v_proposed->>'proposed_body')
    on conflict (tenant_id, slug)
    do update set body_markdown = excluded.body_markdown, updated_at = now();

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
revoke all on function apply_extracted_artifact(uuid) from public;
grant execute on function apply_extracted_artifact(uuid) to authenticated;

create or replace function reject_extracted_artifact(p_artifact_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from extracted_artifacts where id = p_artifact_id;
  if v_tenant is null then
    raise exception 'artifact % not found', p_artifact_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from tenant_users where user_id = auth.uid() and tenant_id = v_tenant) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  update extracted_artifacts
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_artifact_id and status = 'proposed';
end $$;
revoke all on function reject_extracted_artifact(uuid) from public;
grant execute on function reject_extracted_artifact(uuid) to authenticated;

create or replace function ingest_event(
  p_tenant_id uuid, p_provider text, p_external_event_id text,
  p_event_type text, p_payload jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into ingested_events (tenant_id, provider, external_event_id, event_type, payload)
  values (p_tenant_id, p_provider, p_external_event_id, p_event_type, p_payload)
  on conflict (provider, external_event_id) do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke all on function ingest_event(uuid, text, text, text, jsonb) from public;
