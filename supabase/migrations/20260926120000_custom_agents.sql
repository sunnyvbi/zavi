
begin;

create table custom_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text not null check (slug ~ '^c-[a-z0-9]{8,12}$'),
  name text not null check (length(btrim(name)) between 1 and 60),
  name_norm text not null check (length(name_norm) between 1 and 60),
  role text not null default '' check (length(role) <= 500),
  instructions text not null check (length(instructions) between 1 and 20000),
  tools jsonb not null default '[]'::jsonb check (jsonb_typeof(tools) = 'array'),
  default_deliver jsonb check (default_deliver is null or jsonb_typeof(default_deliver) = 'object'),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'archived')),
  paused_reason text,
  consecutive_failures int not null default 0,
  version int not null default 1 check (version >= 1),
  created_by uuid references auth.users(id) on delete set null,
  slack_user_id text,
  test_run_id uuid,
  origin_run_id uuid references agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (id, tenant_id)
);

create unique index custom_agents_tenant_name_live
  on custom_agents (tenant_id, name_norm)
  where status <> 'archived';

create unique index custom_agents_tenant_origin_run
  on custom_agents (tenant_id, origin_run_id)
  where origin_run_id is not null;

create table custom_agent_triggers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null,
  kind text not null check (kind in ('schedule', 'watch')),
  cron text,
  tz text,
  interval_minutes int,
  condition text check (condition is null or length(condition) between 1 and 2000),
  deliver jsonb check (deliver is null or jsonb_typeof(deliver) = 'object'),
  enabled boolean not null default true,
  next_due_at timestamptz,
  last_fired_at timestamptz,
  last_checked_at timestamptz,
  url_baseline jsonb not null default '{}'::jsonb,
  last_fingerprint text,
  last_result_summary text check (last_result_summary is null or length(last_result_summary) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agent_id, tenant_id) references custom_agents(id, tenant_id) on delete cascade,
  constraint custom_agent_triggers_shape check (
    (kind = 'schedule' and cron is not null and tz is not null
       and interval_minutes is null and condition is null)
    or
    (kind = 'watch' and interval_minutes is not null and interval_minutes >= 15
       and condition is not null and cron is null)
  )
);

create table custom_agent_write_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete set null,
  agent_id uuid not null,
  tool_name text not null,
  decision_class text,
  outcome text not null check (outcome in ('attempted', 'succeeded', 'failed', 'blocked_paused')),
  error text check (error is null or length(error) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (agent_id, tenant_id) references custom_agents(id, tenant_id) on delete cascade
);

alter table agent_runs
  add column custom_agent_id uuid references custom_agents(id) on delete set null,
  add column custom_trigger_id uuid references custom_agent_triggers(id) on delete set null,
  add column custom_agent_version int;

alter table custom_agents enable row level security;
create policy custom_agents_select on custom_agents
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy custom_agents_active_tenant_restrict
  on custom_agents as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

alter table custom_agent_triggers enable row level security;
create policy custom_agent_triggers_select on custom_agent_triggers
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy custom_agent_triggers_active_tenant_restrict
  on custom_agent_triggers as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

alter table custom_agent_write_receipts enable row level security;
create policy custom_agent_write_receipts_select on custom_agent_write_receipts
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy custom_agent_write_receipts_active_tenant_restrict
  on custom_agent_write_receipts as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke insert, update, delete on custom_agents, custom_agent_triggers, custom_agent_write_receipts
  from public, anon, authenticated;

create table custom_agent_reserved_names (
  name_norm text primary key check (length(name_norm) between 1 and 60)
);
alter table custom_agent_reserved_names enable row level security;
revoke all on custom_agent_reserved_names from public, anon, authenticated;
insert into custom_agent_reserved_names (name_norm) values
  ('ads manager'),
  ('advisor'),
  ('blog'),
  ('browser operator'),
  ('cgo'),
  ('chatgpt ads'),
  ('chief growth officer'),
  ('chief of staff'),
  ('content design'),
  ('content designer'),
  ('dispute response'),
  ('email campaigns'),
  ('email marketing'),
  ('engineer'),
  ('fundraising'),
  ('funnel analyst'),
  ('generated video'),
  ('geo'),
  ('google ads'),
  ('growth lead'),
  ('head of growth'),
  ('influencer'),
  ('instagram'),
  ('instagram organic'),
  ('linkedin'),
  ('linkedin ads'),
  ('linkedin organic'),
  ('meta ads'),
  ('onboarding discovery'),
  ('operator'),
  ('performance marketer'),
  ('pinterest'),
  ('pinterest organic'),
  ('pm'),
  ('product manager'),
  ('qa'),
  ('reddit'),
  ('reddit ads'),
  ('reddit organic'),
  ('research'),
  ('seo'),
  ('seo ai search'),
  ('seo geo'),
  ('sms'),
  ('supply demand'),
  ('supply demand balancer'),
  ('support lead'),
  ('tiktok'),
  ('tiktok ads'),
  ('tiktok organic'),
  ('ugc'),
  ('x'),
  ('x organic'),
  ('youtube'),
  ('youtube ads'),
  ('youtube organic'),
  ('zavi');

create or replace function _custom_agent_name_norm(p_name text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(p_name, '')), '[-_]', ' ', 'g'),
             '[^a-z0-9 ]', '', 'g'),
           '\s+', ' ', 'g'));
$$;

create or replace function _is_custom_agent_slug(p_slug text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_slug ~ '^c-[a-z0-9]{8,12}$', false);
$$;

create or replace function _is_custom_agent_run(
  p_tenant_id uuid, p_slug text, p_run_id uuid, p_cron_dedupe_key text
) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select _is_custom_agent_slug(p_slug)
     and p_tenant_id is not null
     and exists (
       select 1 from custom_agents c
        where c.tenant_id = p_tenant_id
          and c.slug = p_slug
          and (
            c.status = 'active'
            or (c.status = 'draft'
                and c.test_run_id is not null
                and (c.test_run_id = p_run_id
                     or p_cron_dedupe_key = 'custom-test:' || c.test_run_id::text))
          )
     );
$$;

create or replace function _tier_required_for_run(
  p_tenant_id uuid, p_slug text, p_run_id uuid, p_cron_dedupe_key text
) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when _is_custom_agent_run(p_tenant_id, p_slug, p_run_id, p_cron_dedupe_key) then 'starter'
    else _tier_required(p_slug)
  end;
$$;

create or replace function _custom_agent_authorize(p_tenant_id uuid)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'tenant required' using errcode = '22023';
  end if;
  if auth.role() is not distinct from 'service_role' then
    return;
  end if;
  if auth.uid() is null or not exists (
    select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
end $$;

create or replace function _custom_agent_require_paid(p_tenant_id uuid)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if _tier_rank(_tenant_tier(p_tenant_id)) < _tier_rank('starter') then
    raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = 'starter';
  end if;
end $$;

create or replace function _custom_agent_check_name(
  p_tenant_id uuid, p_name_norm text, p_reserved text[], p_except_id uuid
) returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_name_norm is null or p_name_norm = '' then
    raise exception 'custom_agent_name_invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_reserved, '{}'::text[])) r
     where _custom_agent_name_norm(r) = p_name_norm
  ) or exists (
    select 1 from custom_agent_reserved_names where name_norm = p_name_norm
  ) then
    raise exception 'custom_agent_name_reserved' using errcode = '22023';
  end if;
  if exists (
    select 1 from custom_agents
     where tenant_id = p_tenant_id
       and name_norm = p_name_norm
       and status <> 'archived'
       and (p_except_id is null or id <> p_except_id)
  ) then
    raise exception 'custom_agent_name_taken' using errcode = '23505';
  end if;
end $$;

create or replace function _custom_agent_insert_triggers(
  p_tenant_id uuid, p_agent_id uuid, p_triggers jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t jsonb;
begin
  if p_triggers is null then
    return;
  end if;
  if jsonb_typeof(p_triggers) <> 'array' or jsonb_array_length(p_triggers) > 10 then
    raise exception 'custom_agent_triggers_invalid' using errcode = '22023';
  end if;
  for t in select value from jsonb_array_elements(p_triggers) loop
    insert into custom_agent_triggers (
      tenant_id, agent_id, kind, cron, tz, interval_minutes, condition, deliver, next_due_at
    ) values (
      p_tenant_id, p_agent_id, t->>'kind',
      case when t->>'kind' = 'schedule' then t->>'cron' end,
      case when t->>'kind' = 'schedule' then t->>'tz' end,
      case when t->>'kind' = 'watch' then (t->>'interval_minutes')::int end,
      case when t->>'kind' = 'watch' then t->>'condition' end,
      null,
      case when t->>'kind' = 'schedule' then (t->>'next_due_at')::timestamptz else now() end
    );
  end loop;
end $$;

create or replace function create_custom_agent(
  p_tenant_id uuid,
  p_name text,
  p_role text,
  p_instructions text,
  p_tools jsonb,
  p_default_deliver jsonb,
  p_status text,
  p_triggers jsonb,
  p_reserved_names text[],
  p_created_by uuid default null,
  p_slack_user_id text default null,
  p_origin_run_id uuid default null
) returns custom_agents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_norm text;
  v_row custom_agents;
begin
  perform _custom_agent_authorize(p_tenant_id);
  perform _custom_agent_require_paid(p_tenant_id);
  if p_status not in ('draft', 'active') then
    raise exception 'custom_agent_status_invalid' using errcode = '22023';
  end if;
  if p_origin_run_id is not null then
    if not exists (select 1 from agent_runs where id = p_origin_run_id and tenant_id = p_tenant_id) then
      raise exception 'custom_agent_origin_invalid' using errcode = '22023';
    end if;
    if exists (select 1 from custom_agents where tenant_id = p_tenant_id and origin_run_id = p_origin_run_id) then
      raise exception 'custom_agent_already_created' using errcode = '23505';
    end if;
  end if;
  v_norm := _custom_agent_name_norm(p_name);
  perform _custom_agent_check_name(p_tenant_id, v_norm, p_reserved_names, null);

  insert into custom_agents (
    tenant_id, slug, name, name_norm, role, instructions, tools, default_deliver,
    status, created_by, slack_user_id, origin_run_id
  ) values (
    p_tenant_id,
    'c-' || substr(md5(gen_random_uuid()::text), 1, 10),
    btrim(p_name), v_norm, coalesce(p_role, ''), p_instructions,
    coalesce(p_tools, '[]'::jsonb), p_default_deliver, p_status,
    case when auth.uid() is not null then auth.uid() else p_created_by end,
    case when auth.uid() is not null then null else p_slack_user_id end,
    p_origin_run_id
  ) returning * into v_row;

  perform _custom_agent_insert_triggers(p_tenant_id, v_row.id, p_triggers);
  return v_row;
end $$;

create or replace function update_custom_agent(
  p_tenant_id uuid,
  p_agent_id uuid,
  p_name text,
  p_role text,
  p_instructions text,
  p_tools jsonb,
  p_default_deliver jsonb,
  p_triggers jsonb,
  p_reserved_names text[],
  p_clear_deliver boolean default false
) returns custom_agents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row custom_agents;
  v_norm text;
begin
  perform _custom_agent_authorize(p_tenant_id);
  select * into v_row from custom_agents
   where id = p_agent_id and tenant_id = p_tenant_id and status <> 'archived'
   for update;
  if not found then
    raise exception 'custom_agent_not_found' using errcode = 'P0002';
  end if;
  if p_name is not null then
    v_norm := _custom_agent_name_norm(p_name);
    perform _custom_agent_check_name(p_tenant_id, v_norm, p_reserved_names, p_agent_id);
  end if;

  update custom_agents set
    name            = coalesce(btrim(p_name), name),
    name_norm       = coalesce(v_norm, name_norm),
    role            = coalesce(p_role, role),
    instructions    = coalesce(p_instructions, instructions),
    tools           = coalesce(p_tools, tools),
    default_deliver = case when coalesce(p_clear_deliver, false) then null
                           else coalesce(p_default_deliver, default_deliver) end,
    version         = version + 1,
    updated_at      = now()
  where id = p_agent_id and tenant_id = p_tenant_id
  returning * into v_row;

  if p_triggers is not null then
    delete from custom_agent_triggers where agent_id = p_agent_id and tenant_id = p_tenant_id;
    perform _custom_agent_insert_triggers(p_tenant_id, p_agent_id, p_triggers);
  end if;
  return v_row;
end $$;

create or replace function set_custom_agent_status(
  p_tenant_id uuid, p_agent_id uuid, p_status text
) returns custom_agents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row custom_agents;
begin
  perform _custom_agent_authorize(p_tenant_id);
  if p_status not in ('active', 'paused', 'archived') then
    raise exception 'custom_agent_status_invalid' using errcode = '22023';
  end if;
  if p_status = 'active' then
    perform _custom_agent_require_paid(p_tenant_id);
  end if;
  update custom_agents set
    status        = p_status,
    paused_reason = case when p_status = 'paused' then 'Paused by a teammate' else null end,
    updated_at    = now()
  where id = p_agent_id and tenant_id = p_tenant_id and status <> 'archived'
  returning * into v_row;
  if not found then
    raise exception 'custom_agent_not_found' using errcode = 'P0002';
  end if;
  if p_status = 'archived' then
    update custom_agent_triggers set enabled = false, updated_at = now()
     where agent_id = p_agent_id and tenant_id = p_tenant_id;
  end if;
  return v_row;
end $$;

create or replace function set_custom_agent_test_token(p_tenant_id uuid, p_agent_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_token uuid := gen_random_uuid();
begin
  perform _custom_agent_authorize(p_tenant_id);
  perform _custom_agent_require_paid(p_tenant_id);
  update custom_agents set test_run_id = v_token, updated_at = now()
   where id = p_agent_id and tenant_id = p_tenant_id and status in ('draft', 'active');
  if not found then
    raise exception 'custom_agent_not_found' using errcode = 'P0002';
  end if;
  return v_token;
end $$;

create or replace function stamp_custom_agent_run(
  p_tenant_id uuid, p_run_id uuid, p_trigger_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent custom_agents;
  v_run agent_runs;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role only' using errcode = '42501';
  end if;
  select * into v_run from agent_runs where id = p_run_id and tenant_id = p_tenant_id;
  if not found or not _is_custom_agent_slug(v_run.agent_slug) then
    return null;
  end if;
  select * into v_agent from custom_agents
   where tenant_id = p_tenant_id and slug = v_run.agent_slug;
  if not found then
    return null;
  end if;
  update agent_runs set
    custom_agent_id      = v_agent.id,
    custom_agent_version = v_agent.version,
    custom_trigger_id    = (select id from custom_agent_triggers
                             where id = p_trigger_id and agent_id = v_agent.id)
  where id = p_run_id and tenant_id = p_tenant_id;
  if v_agent.test_run_id is not null
     and v_run.cron_dedupe_key = 'custom-test:' || v_agent.test_run_id::text then
    update custom_agents set test_run_id = p_run_id where id = v_agent.id;
  end if;
  return v_agent.id;
end $$;

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
  v_gated boolean;
  v_build boolean;
  v_preview boolean;
begin
  if NEW.status not in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and not _is_engineer_backend_run(NEW.agent_slug, NEW.enqueued_by, NEW.trigger, NEW.payload) then
    v_build := NEW.enqueued_by is null
               and _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not v_build;
    end if;
    if not v_gated and _tier_channel_gated(NEW.agent_slug) then
      v_gated := true;
    end if;
    if not v_gated and _is_custom_agent_slug(NEW.agent_slug) then
      v_gated := true;
    end if;
    v_preview := _is_signup_preview_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                                        NEW.enqueued_by, NEW.cron_dedupe_key);
    if v_gated and not v_preview then
      v_required := case when v_build then _tier_required('product-builder')
                         else _tier_required_for_run(NEW.tenant_id, NEW.agent_slug,
                                                     NEW.id, NEW.cron_dedupe_key) end;
      if _tier_rank(_tenant_tier(NEW.tenant_id)) < _tier_rank(v_required) then
        raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = v_required;
      end if;
    end if;
  end if;
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if _is_free_build_stage(NEW.tenant_id, NEW.payload, NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
  if _is_signup_preview_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                            NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
  if NEW.status in ('queued', 'running') then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

create or replace function _trg_rereserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
  v_gated boolean;
  v_build boolean;
  v_preview boolean;
begin
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued'
     and not _is_engineer_backend_run(NEW.agent_slug, NEW.enqueued_by, NEW.trigger, NEW.payload) then
    v_build := NEW.enqueued_by is null
               and _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not v_build;
    end if;
    if not v_gated and _tier_channel_gated(NEW.agent_slug) then
      v_gated := true;
    end if;
    if not v_gated and _is_custom_agent_slug(NEW.agent_slug) then
      v_gated := true;
    end if;
    v_preview := _is_signup_preview_identity(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                                        NEW.enqueued_by, NEW.cron_dedupe_key);
    if v_gated and not v_preview then
      v_required := case when v_build then _tier_required('product-builder')
                         else _tier_required_for_run(NEW.tenant_id, NEW.agent_slug,
                                                     NEW.id, NEW.cron_dedupe_key) end;
      if _tier_rank(_tenant_tier(NEW.tenant_id)) < _tier_rank(v_required) then
        raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = v_required;
      end if;
    end if;
  end if;
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if _is_free_build_stage(NEW.tenant_id, NEW.payload, NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
  if _is_signup_preview_identity(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                            NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

revoke all on function _custom_agent_name_norm(text)                        from public, anon, authenticated;
revoke all on function _is_custom_agent_slug(text)                          from public, anon, authenticated;
revoke all on function _is_custom_agent_run(uuid, text, uuid, text)         from public, anon, authenticated;
revoke all on function _tier_required_for_run(uuid, text, uuid, text)       from public, anon, authenticated;
revoke all on function _custom_agent_authorize(uuid)                        from public, anon, authenticated;
revoke all on function _custom_agent_require_paid(uuid)                     from public, anon, authenticated;
revoke all on function _custom_agent_check_name(uuid, text, text[], uuid)   from public, anon, authenticated;
revoke all on function _custom_agent_insert_triggers(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function _custom_agent_name_norm(text)                     to service_role;
grant execute on function _is_custom_agent_slug(text)                       to service_role;
grant execute on function _is_custom_agent_run(uuid, text, uuid, text)      to service_role;
grant execute on function _tier_required_for_run(uuid, text, uuid, text)    to service_role;

revoke all on function create_custom_agent(uuid, text, text, text, jsonb, jsonb, text, jsonb, text[], uuid, text, uuid) from public, anon, authenticated;
revoke all on function update_custom_agent(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text[], boolean) from public, anon, authenticated;
revoke all on function set_custom_agent_status(uuid, uuid, text) from public, anon, authenticated;
revoke all on function set_custom_agent_test_token(uuid, uuid) from public, anon, authenticated;
grant execute on function create_custom_agent(uuid, text, text, text, jsonb, jsonb, text, jsonb, text[], uuid, text, uuid) to authenticated, service_role;
grant execute on function update_custom_agent(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text[], boolean)             to authenticated, service_role;
grant execute on function set_custom_agent_status(uuid, uuid, text)                                                   to authenticated, service_role;
grant execute on function set_custom_agent_test_token(uuid, uuid)                                                     to authenticated, service_role;

revoke all on function _trg_reserve_run_credits()   from public, anon, authenticated;
revoke all on function _trg_rereserve_run_credits() from public, anon, authenticated;

revoke all on function stamp_custom_agent_run(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function stamp_custom_agent_run(uuid, uuid, uuid) to service_role;

create or replace function _custom_agent_member_allowed(
  p_tenant_id uuid, p_slug text, p_statuses text[]
) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select _is_custom_agent_slug(p_slug)
     and exists (
       select 1 from custom_agents
        where tenant_id = p_tenant_id and slug = p_slug and status = any(p_statuses)
     );
$$;
revoke all on function _custom_agent_member_allowed(uuid, text, text[]) from public, anon, authenticated;
grant execute on function _custom_agent_member_allowed(uuid, text, text[]) to service_role;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid default null
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
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

  select app_active_tenant() into v_tenant_id;
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
  ) and not _custom_agent_member_allowed(v_tenant_id, p_agent_slug, array['active']) then
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
revoke all on function send_agent_chat_turn(text, text, text, uuid) from public, anon, authenticated;
grant execute on function send_agent_chat_turn(text, text, text, uuid) to authenticated;

create or replace function send_agent_chat_turn_v2(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
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

  select app_active_tenant() into v_tenant_id;
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
  ) and not _custom_agent_member_allowed(v_tenant_id, p_agent_slug, array['active']) then
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
revoke all on function send_agent_chat_turn_v2(text, text, text, uuid, text[]) from public, anon, authenticated;
grant execute on function send_agent_chat_turn_v2(text, text, text, uuid, text[]) to authenticated;

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
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
  ) and not _custom_agent_member_allowed(v_tenant_id, p_agent_slug, array['active']) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
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
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;
revoke all on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[]) from public, anon, authenticated;
grant execute on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[]) to authenticated;

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[],
  p_tenant_id uuid
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if p_tenant_id is not null then
    v_tenant_id := p_tenant_id;
  end if;
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
  ) and not _custom_agent_member_allowed(v_tenant_id, p_agent_slug, array['active']) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
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
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;
revoke all on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[], uuid) from public, anon, authenticated;
grant execute on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[], uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.submit_clarification_response(p_request_id uuid, p_agent_hash text, p_answers jsonb)
 RETURNS TABLE(run_id uuid, agent_slug text, thread_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_ctx record;
  v_tenant_id uuid;
  v_role text;
  v_slug text;
  v_thread_id uuid;
  v_resp agent_clarification_responses;
  v_run_id uuid;
  v_user_message_id uuid;
  v_body text;
  v_resolved jsonb;
begin
  select * into v_ctx from _owned_clarify_request(p_request_id);
  v_tenant_id := v_ctx.tenant_id;
  v_slug := v_ctx.agent_slug;
  v_thread_id := v_ctx.thread_id;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;
  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id and user_id = v_user_id and agent_slug = v_slug
  ) and not _custom_agent_member_allowed(v_tenant_id, v_slug, array['active']) then
    raise exception 'agent % not in member allowlist', v_slug using errcode = '42501';
  end if;

  perform _validate_clarify_answers(v_ctx.envelope, p_answers);
  v_resolved := _resolve_clarify_pairs(v_ctx.envelope, p_answers);

  insert into agent_clarification_responses (request_id, thread_id, tenant_id, user_id, draft_answers)
  values (p_request_id, v_thread_id, v_tenant_id, v_user_id, '{}'::jsonb)
  on conflict (tenant_id, request_id, user_id) do nothing;

  select * into v_resp from agent_clarification_responses
    where tenant_id = v_tenant_id and request_id = p_request_id and user_id = v_user_id
    for update;

  if v_resp.status = 'consumed' then
    raise exception 'clarification already consumed' using errcode = '22023';
  end if;
  if v_resp.consuming_run_id is not null and exists (
    select 1 from agent_runs r
     where r.id = v_resp.consuming_run_id
       and r.status in ('queued','running','blocked')
  ) then
    raise exception 'a submission for this request is already in progress' using errcode = '22023';
  end if;

  v_body := 'Answered the clarifying questions.';
  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, v_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, meta)
  values
    (v_thread_id, v_tenant_id, 'user', v_body, v_run_id,
     jsonb_build_object('clarification_response',
        jsonb_build_object('request_id', p_request_id, 'answers', p_answers,
          'resolved', v_resolved)))
  returning id into v_user_message_id;

  update agent_runs set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'prior_run_id', (select agent_run_id from agent_thread_messages
                       where tenant_id = v_tenant_id and thread_id = v_thread_id
                         and sender_role = 'assistant'
                         and meta->'envelope'->>'request_id' = p_request_id::text
                         and meta->'envelope'->>'envelope_kind' = 'clarifying_questions' limit 1),
      'clarification_response', jsonb_build_object('request_id', p_request_id, 'answers', p_answers,
        'resolved', v_resolved)
    ) where id = v_run_id;

  update agent_clarification_responses
    set submitted_answers = p_answers, status = 'submitted',
        consuming_run_id = v_run_id, updated_at = now()
    where id = v_resp.id;

  update agent_threads set last_message_at = now() where id = v_thread_id;

  return query select v_run_id, v_slug, v_thread_id;
end $function$
;
revoke all on function submit_clarification_response(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function submit_clarification_response(uuid, text, jsonb) to authenticated;

commit;
