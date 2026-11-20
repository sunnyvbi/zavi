

update tenant_users
   set role = 'owner'
 where role is null or role not in ('owner','admin','member');

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'tenant_users_role_check'
       and conrelid = 'tenant_users'::regclass
  ) then
    alter table tenant_users
      add constraint tenant_users_role_check
      check (role in ('owner','admin','member'));
  end if;
end $$;

create unique index if not exists tenant_users_one_owner_per_tenant
  on tenant_users (tenant_id)
  where role = 'owner';

create or replace function activate_tenant(
  p_slug text,
  p_display_name text,
  p_rar numeric,
  p_memory jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_existing_owner uuid;
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select id into v_tenant_id from tenants where slug = p_slug;

  if v_tenant_id is not null then
    select user_id into v_existing_owner
      from tenant_users
     where tenant_id = v_tenant_id and user_id = v_caller;
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
  values (v_caller, v_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (v_caller, v_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  insert into memory_docs (tenant_id, slug, body_markdown)
  select v_tenant_id, key, value
  from jsonb_each_text(p_memory)
  on conflict (tenant_id, slug)
  do update set body_markdown = excluded.body_markdown, updated_at = now();

  return v_tenant_id;
end $$;

create table if not exists tenant_member_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','member')),
  invited_by uuid not null references auth.users(id),
  invited_at timestamptz default now(),
  accepted_at timestamptz,
  accepted_user_id uuid references auth.users(id),
  revoked_at timestamptz,
  agent_slugs text[] not null default array[]::text[]
);

create unique index if not exists tenant_member_invites_open_email_unique
  on tenant_member_invites (tenant_id, lower(email))
  where accepted_at is null and revoked_at is null;

create index if not exists tenant_member_invites_open
  on tenant_member_invites (tenant_id)
  where accepted_at is null and revoked_at is null;

create table if not exists tenant_member_agents (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_slug text not null,
  added_at timestamptz default now(),
  added_by uuid references auth.users(id),
  primary key (tenant_id, user_id, agent_slug)
);

create index if not exists tenant_member_agents_lookup
  on tenant_member_agents (tenant_id, user_id);

create table if not exists tenant_seat_limits (
  tier text primary key,
  max_seats int not null,
  created_at timestamptz default now()
);

insert into tenant_seat_limits (tier, max_seats) values
  ('pilot',    3),
  ('operator', 10),
  ('scale',    -1)
on conflict (tier) do nothing;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tenants'
       and column_name = 'tier'
  ) then
    alter table tenants
      add column tier text not null default 'pilot'
      check (tier in ('pilot','operator','scale'));
  end if;
end $$;

create or replace function _assert_tenant_admin(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select role into v_role from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  if v_role not in ('owner','admin') then
    raise exception 'forbidden — role % cannot perform admin action', v_role using errcode = '42501';
  end if;
end $$;
revoke all on function _assert_tenant_admin(uuid) from public;
grant execute on function _assert_tenant_admin(uuid) to authenticated;

create or replace function upsert_agent_schedule(
  p_tenant_id uuid,
  p_agent_slug text,
  p_cron_expression text,
  p_enabled boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_agent_slug is null or length(trim(p_agent_slug)) = 0 then
    raise exception 'agent_slug required' using errcode = '22023';
  end if;

  if p_cron_expression !~ '^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$'
     or p_cron_expression ~ '[^0-9*,/ -]' then
    raise exception 'invalid cron_expression %', p_cron_expression
      using errcode = '22023';
  end if;

  insert into tenant_agent_schedules
    (tenant_id, agent_slug, cron_expression, enabled)
  values
    (p_tenant_id, p_agent_slug, trim(p_cron_expression), coalesce(p_enabled, true))
  on conflict (tenant_id, agent_slug) do update
    set cron_expression = excluded.cron_expression,
        enabled = excluded.enabled;
end $$;

create or replace function delete_agent_schedule(
  p_tenant_id uuid,
  p_agent_slug text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _assert_tenant_admin(p_tenant_id);
  delete from tenant_agent_schedules
   where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
end $$;

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
  perform _assert_tenant_admin(p_tenant_id);

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

create or replace function set_tenant_sandbox_keepalive(
  p_tenant_id uuid,
  p_enabled boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _assert_tenant_admin(p_tenant_id);
  update tenants
     set sandbox_keepalive_enabled = p_enabled
   where id = p_tenant_id;
  return p_enabled;
end $$;

create or replace function set_tenant_autonomy(
  p_tenant_id uuid,
  p_decision_class text,
  p_autonomy decision_autonomy
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _assert_tenant_admin(p_tenant_id);
  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy, updated_by
  ) values (
    p_tenant_id, p_decision_class, p_autonomy, auth.uid()
  )
  on conflict (tenant_id, decision_class)
  do update set autonomy = excluded.autonomy,
                updated_by = excluded.updated_by,
                updated_at = now();
end $$;

create or replace function approve_decision(p_decision_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text;
begin
  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;
  if v_status != 'proposed' then
    raise exception 'decision % is in status % (must be proposed)', p_decision_id, v_status using errcode = '22023';
  end if;
  perform _assert_tenant_admin(v_tenant);
  update decisions
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_decision_id;
end $$;

create or replace function reject_decision(p_decision_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text;
begin
  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;
  if v_status != 'proposed' then
    raise exception 'decision % is in status % (must be proposed)', p_decision_id, v_status using errcode = '22023';
  end if;
  perform _assert_tenant_admin(v_tenant);
  update decisions
     set status = 'rejected', approved_by = auth.uid(), approved_at = now()
   where id = p_decision_id;
end $$;

create or replace function set_kill_switch(
  p_tenant_id uuid,
  p_agent_slug text,
  p_kill boolean,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_source text;
begin
  perform _assert_tenant_admin(p_tenant_id);

  select source into v_source
    from tenant_agent_kill_switch
   where tenant_id = p_tenant_id and agent_slug = p_agent_slug;

  if p_kill then
    if v_source = 'staff' then
      return;
    elsif v_source = 'tenant' then
      update tenant_agent_kill_switch
         set killed_at = now(), killed_by = auth.uid(), reason = p_reason
       where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
    else
      insert into tenant_agent_kill_switch
        (tenant_id, agent_slug, killed_by, reason, source)
        values (p_tenant_id, p_agent_slug, auth.uid(), p_reason, 'tenant');
    end if;
  else
    if v_source = 'staff' then
      raise exception 'agent hidden by Praxis — contact support to re-enable'
        using errcode = '42501';
    end if;
    delete from tenant_agent_kill_switch
      where tenant_id = p_tenant_id and agent_slug = p_agent_slug
        and source = 'tenant';
  end if;
end $$;

create or replace function set_operator_db_connection(
  p_tenant_id uuid,
  p_type text,
  p_connection_string text,
  p_schema_map jsonb
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
begin
  perform _assert_tenant_admin(p_tenant_id);

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at)
  values (p_tenant_id, p_type::operator_db_type, v_secret_key, p_schema_map, now())
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'operator_db',
    p_type,
    'Operator DB',
    array['read', 'update_status']::text[],
    now()
  )
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, connected_at = excluded.connected_at;
end $$;

create or replace function update_tenant_notification_settings(
  p_notification_email text,
  p_timezone text,
  p_digest_frequency text
) returns tenants
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row tenants;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  if p_digest_frequency not in ('off', 'daily') then
    raise exception 'invalid digest_frequency: %, must be off|daily', p_digest_frequency
      using errcode = '22023';
  end if;

  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'invalid timezone: %', p_timezone using errcode = '22023';
  end if;

  update tenants
     set notification_email = nullif(trim(p_notification_email), ''),
         timezone           = p_timezone,
         digest_frequency   = p_digest_frequency
   where id = v_tenant
   returning * into v_row;

  return v_row;
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
  perform _assert_tenant_admin(v_tenant);

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

create or replace function delete_tenant_command(p_slug text) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);
  delete from tenant_commands
   where tenant_id = v_tenant and slug = lower(p_slug);
end $$;

create or replace function trigger_team_discover(
  p_providers text[] default array['github','slack','jira']
)
returns table (job_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_existing_id uuid;
  v_new_id uuid;
begin
  if p_providers is null or array_length(p_providers, 1) is null then
    raise exception 'providers must be non-empty' using errcode = '22023';
  end if;
  if not (p_providers <@ array['github','slack','jira']::text[]) then
    raise exception 'invalid provider in array' using errcode = '22023';
  end if;

  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  perform _assert_tenant_admin(v_tenant);

  select id into v_existing_id from team_discover_jobs
   where tenant_id = v_tenant and status in ('queued','running')
   order by created_at desc limit 1;
  if v_existing_id is not null then
    return query select v_existing_id, false;
    return;
  end if;

  insert into team_discover_jobs (tenant_id, triggered_by, providers)
  values (v_tenant, auth.uid(), p_providers)
  returning id into v_new_id;
  return query select v_new_id, true;
end $$;

create or replace function update_team_member(
  p_member_id uuid,
  p_display_name text default null,
  p_primary_email text default null,
  p_kind text default null
) returns team_members
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row team_members;
  v_email_normalized text;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  perform _assert_tenant_admin(v_tenant);
  if p_kind is not null and p_kind not in ('human','bot','service_account') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  v_email_normalized := nullif(lower(trim(p_primary_email)), '');

  update team_members
     set display_name  = coalesce(nullif(trim(p_display_name), ''), display_name),
         primary_email = coalesce(v_email_normalized, primary_email),
         kind          = coalesce(p_kind, kind),
         updated_at    = now()
   where id = p_member_id and tenant_id = v_tenant
   returning * into v_row;
  if not found then raise exception 'member not found' using errcode = '42704'; end if;
  return v_row;
end $$;

create or replace function merge_team_members(p_keep_id uuid, p_drop_id uuid)
returns team_members
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_keep team_members;
  v_drop team_members;
begin
  if p_keep_id = p_drop_id then raise exception 'cannot merge member with itself' using errcode = '22023'; end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  perform _assert_tenant_admin(v_tenant);

  select * into v_keep from team_members
   where id = p_keep_id and tenant_id = v_tenant for update;
  if not found or v_keep.status <> 'active' then
    raise exception 'keep member not found or not active' using errcode = '42704';
  end if;
  select * into v_drop from team_members
   where id = p_drop_id and tenant_id = v_tenant for update;
  if not found or v_drop.status <> 'active' then
    raise exception 'drop member not found or not active' using errcode = '42704';
  end if;

  delete from team_member_identities
   where member_id = p_drop_id and tenant_id = v_tenant
     and (provider, external_id) in (
       select provider, external_id from team_member_identities
       where member_id = p_keep_id and tenant_id = v_tenant
     );

  update team_member_identities
     set member_id = p_keep_id, source = 'admin'
   where member_id = p_drop_id and tenant_id = v_tenant;

  update team_members
     set status = 'merged_into', merged_into_id = p_keep_id, updated_at = now()
   where id = p_drop_id and tenant_id = v_tenant;

  update team_members set updated_at = now()
   where id = p_keep_id and tenant_id = v_tenant
   returning * into v_keep;
  return v_keep;
end $$;

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
  perform _assert_tenant_admin(p_tenant_id);

  if p_id is not null then
    select slug into v_existing_slug from memory_note
     where id = p_id and tenant_id = p_tenant_id;
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
  perform _assert_tenant_admin(p_tenant_id);
  select slug into v_slug from memory_note where id = p_id and tenant_id = p_tenant_id;
  if v_slug is not null then
    raise exception 'cannot delete anchor (slug=%); anchors are rewritable, not deletable', v_slug using errcode = '22023';
  end if;
  delete from memory_note where id = p_id and tenant_id = p_tenant_id;
end $$;

create or replace function memory_entity_upsert(
  p_tenant_id uuid,
  p_entity_type text,
  p_canonical_name text,
  p_attrs jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _assert_tenant_admin(p_tenant_id);
  insert into memory_entity (tenant_id, entity_type, canonical_name, attrs, last_seen_at)
    values (p_tenant_id, p_entity_type, p_canonical_name, coalesce(p_attrs, '{}'::jsonb), now())
  on conflict (tenant_id, entity_type, canonical_name) do update set
    attrs = memory_entity.attrs || coalesce(excluded.attrs, '{}'::jsonb),
    last_seen_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function memory_relation_upsert(
  p_tenant_id uuid,
  p_src_entity_id uuid,
  p_dst_entity_id uuid,
  p_relation_type text,
  p_confidence numeric,
  p_source_note_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _assert_tenant_admin(p_tenant_id);
  insert into memory_relation (tenant_id, src_entity_id, dst_entity_id, relation_type, confidence, source_note_id)
    values (p_tenant_id, p_src_entity_id, p_dst_entity_id, p_relation_type, coalesce(p_confidence, 0.5), p_source_note_id)
  on conflict (tenant_id, src_entity_id, dst_entity_id, relation_type) do update set
    confidence = greatest(memory_relation.confidence, excluded.confidence),
    source_note_id = coalesce(excluded.source_note_id, memory_relation.source_note_id)
  returning id into v_id;
  return v_id;
end $$;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid default null
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if length(coalesce(p_message, '')) = 0 or length(p_message) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id, left(p_message, 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id)
  values
    (v_thread_id, v_tenant_id, 'user', p_message, v_run_id)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

create or replace function send_agent_chat_turn_v2(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_attachments jsonb;
  v_path_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = '' and coalesce(array_length(p_image_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;

  v_path_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_path_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'image attached'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p))
      into v_attachments
      from unnest(p_image_paths) as p;
  else
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

alter table tenant_member_invites enable row level security;
alter table tenant_member_agents  enable row level security;

drop policy if exists invites_select on tenant_member_invites;
create policy invites_select on tenant_member_invites for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = tenant_member_invites.tenant_id
       and tu.role in ('owner','admin')
  )
);

drop policy if exists member_agents_select on tenant_member_agents;
create policy member_agents_select on tenant_member_agents for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = tenant_member_agents.tenant_id
       and (tu.role in ('owner','admin') or tu.user_id = tenant_member_agents.user_id)
  )
);

drop policy if exists agent_runs_member_select on agent_runs;
create policy agent_runs_member_select on agent_runs for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = agent_runs.tenant_id
       and (
         tu.role in ('owner','admin')
         or (
           exists (
             select 1 from tenant_member_agents tma
              where tma.tenant_id = agent_runs.tenant_id
                and tma.user_id = auth.uid()
                and tma.agent_slug = agent_runs.agent_slug
           )
           and (
             agent_runs.enqueued_by is null
             or agent_runs.enqueued_by = auth.uid()
           )
         )
       )
  )
);

drop policy if exists agent_run_events_member_select on agent_run_events;
create policy agent_run_events_member_select on agent_run_events for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = agent_run_events.tenant_id
       and (
         tu.role in ('owner','admin')
         or exists (
           select 1 from agent_runs ar
           join tenant_member_agents tma
             on tma.tenant_id = ar.tenant_id
            and tma.user_id = auth.uid()
            and tma.agent_slug = ar.agent_slug
            where ar.id = agent_run_events.agent_run_id
              and (ar.enqueued_by is null or ar.enqueued_by = auth.uid())
         )
       )
  )
);

drop policy if exists decisions_member_select on decisions;
create policy decisions_member_select on decisions for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = decisions.tenant_id
       and (
         tu.role in ('owner','admin')
         or (
           decisions.agent_run_id is not null
           and exists (
             select 1 from agent_runs ar
             join tenant_member_agents tma
               on tma.tenant_id = ar.tenant_id
              and tma.user_id = auth.uid()
              and tma.agent_slug = ar.agent_slug
             where ar.id = decisions.agent_run_id
               and (ar.enqueued_by is null or ar.enqueued_by = auth.uid())
           )
         )
       )
  )
);

drop policy if exists tenant_users_select_members on tenant_users;
create policy tenant_users_select_members on tenant_users for select using (
  exists (
    select 1 from tenant_users tu2
     where tu2.user_id = auth.uid()
       and tu2.tenant_id = tenant_users.tenant_id
  )
);

create or replace function invite_member(
  p_email text,
  p_role text,
  p_agent_slugs text[]
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_email_normalized text;
  v_existing_seats int;
  v_open_invites int;
  v_max int;
  v_tier text;
  v_invite_id uuid;
  v_slugs text[];
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  if p_role is null or p_role not in ('admin','member') then
    raise exception 'invalid role %; must be admin or member', p_role using errcode = '22023';
  end if;

  v_email_normalized := lower(trim(coalesce(p_email, '')));
  if v_email_normalized = '' then
    raise exception 'email required' using errcode = '22023';
  end if;

  if p_role = 'admin' then
    v_slugs := array[]::text[];
  else
    v_slugs := coalesce(p_agent_slugs, array[]::text[]);
  end if;

  select tier into v_tier from tenants where id = v_tenant;
  select max_seats into v_max from tenant_seat_limits where tier = coalesce(v_tier, 'pilot');
  if v_max is null then
    raise exception 'no seat limit defined for tier %', v_tier using errcode = '22023';
  end if;
  if v_max >= 0 then
    select count(*) into v_existing_seats from tenant_users where tenant_id = v_tenant;
    select count(*) into v_open_invites from tenant_member_invites
      where tenant_id = v_tenant
        and accepted_at is null
        and revoked_at is null;
    if (v_existing_seats + v_open_invites) >= v_max then
      raise exception 'seat_cap_exceeded — tier % allows % seats (%/% used)',
        v_tier, v_max, v_existing_seats + v_open_invites, v_max
        using errcode = '42501';
    end if;
  end if;

  insert into tenant_member_invites (tenant_id, email, role, invited_by, agent_slugs)
  values (v_tenant, v_email_normalized, p_role, auth.uid(), v_slugs)
  on conflict (tenant_id, lower(email))
    where accepted_at is null and revoked_at is null
  do update set
    role         = excluded.role,
    invited_by   = excluded.invited_by,
    agent_slugs  = excluded.agent_slugs,
    invited_at   = now()
  returning id into v_invite_id;

  return v_invite_id;
end $$;

create or replace function accept_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_invite tenant_member_invites;
  v_caller_email text;
  v_slug text;
  v_existing_profile uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select email into v_caller_email from auth.users where id = auth.uid();
  if v_caller_email is null then
    raise exception 'caller email unknown' using errcode = '42501';
  end if;

  select * into v_invite from tenant_member_invites where id = p_invite_id;
  if v_invite.id is null then
    raise exception 'invite % not found', p_invite_id using errcode = '42704';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite already accepted' using errcode = '42501';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite revoked' using errcode = '42501';
  end if;
  if lower(v_caller_email) <> lower(v_invite.email) then
    raise exception 'invite is for a different email' using errcode = '42501';
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (auth.uid(), v_invite.tenant_id, v_invite.role)
  on conflict (user_id, tenant_id) do nothing;

  if v_invite.role = 'member' then
    foreach v_slug in array v_invite.agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_invite.tenant_id, auth.uid(), v_slug, v_invite.invited_by)
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;

  update tenant_member_invites
     set accepted_at = now(),
         accepted_user_id = auth.uid()
   where id = p_invite_id;

  select active_tenant_id into v_existing_profile from profiles where user_id = auth.uid();
  if v_existing_profile is null then
    insert into profiles (user_id, active_tenant_id)
    values (auth.uid(), v_invite.tenant_id)
    on conflict (user_id) do update
      set active_tenant_id = coalesce(profiles.active_tenant_id, excluded.active_tenant_id);
  end if;
end $$;

create or replace function set_member_agents(
  p_user_id uuid,
  p_agent_slugs text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_target_role text;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member of tenant' using errcode = '42704';
  end if;
  if v_target_role <> 'member' then
    raise exception 'cannot set agents for role %; only members have allowlists', v_target_role using errcode = '22023';
  end if;

  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;

  if p_agent_slugs is not null then
    foreach v_slug in array p_agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_tenant, p_user_id, v_slug, auth.uid())
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;
end $$;

create or replace function promote_member_to_admin(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role <> 'owner' then
    raise exception 'only owner can promote members' using errcode = '42501';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member' using errcode = '42704';
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot promote owner' using errcode = '22023';
  end if;
  if v_target_role = 'admin' then
    return;
  end if;

  update tenant_users
     set role = 'admin'
   where tenant_id = v_tenant and user_id = p_user_id;

  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;
end $$;

create or replace function demote_admin_to_member(
  p_user_id uuid,
  p_agent_slugs text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role <> 'owner' then
    raise exception 'only owner can demote admins' using errcode = '42501';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member' using errcode = '42704';
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot demote owner' using errcode = '22023';
  end if;
  if v_target_role = 'member' then
    return;
  end if;

  update tenant_users
     set role = 'member'
   where tenant_id = v_tenant and user_id = p_user_id;

  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;

  if p_agent_slugs is not null then
    foreach v_slug in array p_agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_tenant, p_user_id, v_slug, auth.uid())
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;
end $$;

create or replace function revoke_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role not in ('owner','admin') then
    raise exception 'forbidden — role % cannot revoke members', v_caller_role using errcode = '42501';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    return;
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot revoke owner' using errcode = '22023';
  end if;
  if v_caller_role = 'admin' and v_target_role = 'admin' then
    raise exception 'admins cannot revoke other admins; only owner can' using errcode = '42501';
  end if;

  delete from tenant_users
   where tenant_id = v_tenant and user_id = p_user_id;
  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;
end $$;

create or replace function revoke_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_active_tenant uuid;
  v_invite_tenant uuid;
  v_accepted_at timestamptz;
  v_revoked_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_active_tenant from profiles where user_id = auth.uid();
  if v_active_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_active_tenant);

  select tenant_id, accepted_at, revoked_at
    into v_invite_tenant, v_accepted_at, v_revoked_at
    from tenant_member_invites where id = p_invite_id;
  if v_invite_tenant is null then
    raise exception 'invite % not found', p_invite_id using errcode = '42704';
  end if;
  if v_invite_tenant <> v_active_tenant then
    raise exception 'invite belongs to a different tenant' using errcode = '42501';
  end if;
  if v_accepted_at is not null then
    raise exception 'invite already accepted; revoke the resulting member via revoke_member' using errcode = '22023';
  end if;
  if v_revoked_at is not null then
    return;
  end if;

  update tenant_member_invites
     set revoked_at = now()
   where id = p_invite_id;
end $$;

revoke all on function invite_member(text, text, text[]) from public;
revoke all on function accept_invite(uuid) from public;
revoke all on function set_member_agents(uuid, text[]) from public;
revoke all on function promote_member_to_admin(uuid) from public;
revoke all on function demote_admin_to_member(uuid, text[]) from public;
revoke all on function revoke_member(uuid) from public;
revoke all on function revoke_invite(uuid) from public;

grant execute on function invite_member(text, text, text[]) to authenticated;
grant execute on function accept_invite(uuid) to authenticated;
grant execute on function set_member_agents(uuid, text[]) to authenticated;
grant execute on function promote_member_to_admin(uuid) to authenticated;
grant execute on function demote_admin_to_member(uuid, text[]) to authenticated;
grant execute on function revoke_member(uuid) to authenticated;
grant execute on function revoke_invite(uuid) to authenticated;
