
begin;

set lock_timeout = '5s';

create table if not exists public.tenant_rules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  scope_kind    text not null check (scope_kind in ('all', 'agent', 'channel')),
  scope_slug    text,
  text          text not null,
  status        text not null
                  check (status in ('suggested', 'active', 'dismissed', 'superseded', 'deleted')),
  origin        text not null check (origin in (
                  'chat_typed', 'slack_typed', 'cgo_email_reply', 'cgo_slack_reply',
                  'reject_reason', 'rules_page', 'feedback_command',
                  'imported_rules_tab', 'moved_from_personalization')),
  source_ref    text,
  source_start  integer,
  source_end    integer,
  source_hash   text,
  excerpt       text,
  suggested_by  text,
  created_by    uuid,
  approved_by   uuid,
  approved_at   timestamptz,
  supersedes    uuid references public.tenant_rules(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tenant_rules_scope_slug check (
    (scope_kind = 'all' and scope_slug is null)
    or (scope_kind <> 'all' and scope_slug is not null and length(scope_slug) between 1 and 120)
  ),
  constraint tenant_rules_text_len check (
    (status = 'deleted' and text = '')
    or (status <> 'deleted' and length(text) between 1 and 280)
  ),
  constraint tenant_rules_span check (
    (source_start is null and source_end is null)
    or (source_start >= 0 and source_end > source_start)
  )
);

create unique index if not exists tenant_rules_idempotency
  on public.tenant_rules (tenant_id, origin, source_ref, source_hash)
  where source_ref is not null;
create index if not exists tenant_rules_tenant_status
  on public.tenant_rules (tenant_id, status);

alter table public.tenant_rules enable row level security;

create policy tenant_rules_member_select on public.tenant_rules
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_rules.tenant_id
    )
  );
create policy tenant_rules_active_tenant_restrict
  on public.tenant_rules as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.tenant_rules from public, anon, authenticated;
grant select (id, tenant_id, scope_kind, scope_slug, text, status, origin,
              suggested_by, created_by, approved_by, approved_at, supersedes,
              created_at, updated_at)
  on public.tenant_rules to authenticated;
revoke all on public.tenant_rules from service_role;
grant select on public.tenant_rules to service_role;

create table if not exists public.tenant_rule_settings (
  tenant_id           uuid primary key references public.tenants(id) on delete cascade,
  suggestions_paused  boolean not null default false,
  updated_by          uuid,
  updated_at          timestamptz not null default now()
);
alter table public.tenant_rule_settings enable row level security;
create policy tenant_rule_settings_member_select on public.tenant_rule_settings
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_rule_settings.tenant_id
    )
  );
revoke all on public.tenant_rule_settings from public, anon, authenticated;
grant select on public.tenant_rule_settings to authenticated;
revoke all on public.tenant_rule_settings from service_role;
grant select on public.tenant_rule_settings to service_role;

alter table public.agent_runs add column if not exists rule_set_hash text;

create or replace function public._rules_actor_role(p_tenant_id uuid, p_actor uuid)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role text;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception 'rules: tenant and actor are required' using errcode = '22023';
  end if;
  select role into v_role from tenant_users
   where tenant_id = p_tenant_id and user_id = p_actor;
  if v_role is null then
    raise exception 'rules: actor is not a member of this tenant' using errcode = '42501';
  end if;
  return v_role;
end $$;
revoke all on function public._rules_actor_role(uuid, uuid) from public, anon, authenticated;

create or replace function public._rules_assert_manager(p_tenant_id uuid, p_actor uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if _rules_actor_role(p_tenant_id, p_actor) not in ('owner', 'admin') then
    raise exception 'rules: only an owner or admin can do this' using errcode = '42501';
  end if;
end $$;
revoke all on function public._rules_assert_manager(uuid, uuid) from public, anon, authenticated;

create or replace function public._rules_clean_text(p_text text)
returns text
language plpgsql immutable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  v := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  if length(v) = 0 then
    raise exception 'rules: a rule needs some words' using errcode = '22023';
  end if;
  if length(v) > 280 then
    raise exception 'rules: a rule can be at most 280 characters' using errcode = '22023';
  end if;
  if v ~ '\m\d{3}[ -]?\d{2}[ -]?\d{4}\M'
     or v ~ '(\d[ -]?){13,19}' then
    raise exception 'rules: this looks like a card or ID number, which cannot be saved in a rule'
      using errcode = '22023', hint = 'sensitive_number';
  end if;
  return v;
end $$;
revoke all on function public._rules_clean_text(text) from public, anon, authenticated;

create or replace function public._rules_redact(p_text text)
returns text
language sql immutable security definer set search_path = public, pg_temp as $$
  select regexp_replace(
           regexp_replace(coalesce(p_text, ''), '(\d[ -]?){13,19}', '[number removed]', 'g'),
           '\m\d{3}[ -]?\d{2}[ -]?\d{4}\M', '[number removed]', 'g')
$$;
revoke all on function public._rules_redact(text) from public, anon, authenticated;

create or replace function public._rules_check_scope(p_scope_kind text, p_scope_slug text)
returns void
language plpgsql immutable security definer set search_path = public, pg_temp as $$
begin
  if p_scope_kind not in ('all', 'agent', 'channel') then
    raise exception 'rules: unknown scope' using errcode = '22023';
  end if;
  if (p_scope_kind = 'all') <> (p_scope_slug is null) then
    raise exception 'rules: scope and slug do not match' using errcode = '22023';
  end if;
end $$;
revoke all on function public._rules_check_scope(text, text) from public, anon, authenticated;

create or replace function public._rules_lock_and_check_cap(p_tenant_id uuid, p_adding integer)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_active integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant_rules:' || p_tenant_id::text, 0));
  select count(*) into v_active from tenant_rules
   where tenant_id = p_tenant_id and status = 'active';
  if v_active + p_adding > 30 then
    raise exception 'rules: this company already has 30 active rules; delete one first'
      using errcode = 'P0001', hint = 'rule_cap';
  end if;
end $$;
revoke all on function public._rules_lock_and_check_cap(uuid, integer) from public, anon, authenticated;

create or replace function public.rule_add(
  p_tenant_id    uuid,
  p_actor        uuid,
  p_text         text,
  p_scope_kind   text,
  p_scope_slug   text,
  p_origin       text,
  p_source_ref   text default null,
  p_source_start integer default null,
  p_source_end   integer default null,
  p_source_hash  text default null,
  p_excerpt      text default null,
  p_suggested_by text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role    text := _rules_actor_role(p_tenant_id, p_actor);
  v_text    text := _rules_clean_text(p_text);
  v_status  text;
  v_id      uuid;
  v_dup     uuid;
begin
  if v_role = 'viewer' then
    raise exception 'rules: viewers cannot add rules' using errcode = '42501';
  end if;
  perform _rules_check_scope(p_scope_kind, p_scope_slug);
  if p_origin not in ('chat_typed', 'slack_typed', 'cgo_email_reply', 'cgo_slack_reply',
                      'reject_reason', 'rules_page', 'feedback_command') then
    raise exception 'rules: origin not allowed here' using errcode = '22023';
  end if;

  v_status := case when v_role in ('owner', 'admin') then 'active' else 'suggested' end;

  if v_status = 'active' then
    perform _rules_lock_and_check_cap(p_tenant_id, 0);
    select id into v_dup from tenant_rules
     where tenant_id = p_tenant_id and status = 'active'
       and scope_kind = p_scope_kind and scope_slug is not distinct from p_scope_slug
       and lower(text) = lower(v_text)
     limit 1;
    if v_dup is not null then
      return jsonb_build_object('status', 'duplicate', 'rule_id', v_dup);
    end if;
    perform _rules_lock_and_check_cap(p_tenant_id, 1);
  end if;

  insert into tenant_rules (
    tenant_id, scope_kind, scope_slug, text, status, origin,
    source_ref, source_start, source_end, source_hash, excerpt,
    suggested_by, created_by, approved_by, approved_at
  ) values (
    p_tenant_id, p_scope_kind, p_scope_slug, v_text, v_status, p_origin,
    p_source_ref, p_source_start, p_source_end, p_source_hash, _rules_redact(left(p_excerpt, 600)),
    coalesce(p_suggested_by, p_actor::text), p_actor,
    case when v_status = 'active' then p_actor end,
    case when v_status = 'active' then now() end
  )
  on conflict (tenant_id, origin, source_ref, source_hash) where source_ref is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from tenant_rules
     where tenant_id = p_tenant_id and origin = p_origin
       and source_ref = p_source_ref and source_hash is not distinct from p_source_hash;
    return jsonb_build_object('status', 'exists', 'rule_id', v_id);
  end if;
  return jsonb_build_object('status', v_status, 'rule_id', v_id);
end $$;
revoke all on function public.rule_add(uuid, uuid, text, text, text, text, text, integer, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.rule_add(uuid, uuid, text, text, text, text, text, integer, integer, text, text, text)
  to service_role;

create or replace function public.rule_activate(p_tenant_id uuid, p_actor uuid, p_rule_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row tenant_rules%rowtype;
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  perform _rules_lock_and_check_cap(p_tenant_id, 0);
  select * into v_row from tenant_rules
   where id = p_rule_id and tenant_id = p_tenant_id for update;
  if v_row.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.status = 'active' then
    return jsonb_build_object('status', 'active', 'rule_id', v_row.id);
  end if;
  if v_row.source_ref like 'chat_message:%' then
    if exists (select 1 from agent_thread_messages m
                where m.tenant_id = p_tenant_id
                  and m.id::text = substring(v_row.source_ref from 14)
                  and coalesce(m.meta, '{}'::jsonb) ? 'superseded_by') then
      return jsonb_build_object('status', 'source_edited');
    end if;
  end if;
  if v_row.status <> 'suggested' then
    return jsonb_build_object('status', 'not_pending', 'current', v_row.status);
  end if;
  perform _rules_lock_and_check_cap(
    p_tenant_id,
    case when v_row.supersedes is not null
          and exists (select 1 from tenant_rules where id = v_row.supersedes
                        and tenant_id = p_tenant_id and status = 'active')
         then 0 else 1 end);
  if v_row.supersedes is not null then
    update tenant_rules set status = 'superseded', updated_at = now()
     where id = v_row.supersedes and tenant_id = p_tenant_id and status = 'active';
  end if;
  update tenant_rules
     set status = 'active', approved_by = p_actor, approved_at = now(), updated_at = now()
   where id = v_row.id;
  return jsonb_build_object('status', 'active', 'rule_id', v_row.id);
end $$;
revoke all on function public.rule_activate(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rule_activate(uuid, uuid, uuid) to service_role;

create or replace function public.rule_edit(
  p_tenant_id uuid, p_actor uuid, p_rule_id uuid,
  p_text text, p_scope_kind text, p_scope_slug text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old  tenant_rules%rowtype;
  v_text text := _rules_clean_text(p_text);
  v_id   uuid;
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  perform _rules_check_scope(p_scope_kind, p_scope_slug);
  perform _rules_lock_and_check_cap(p_tenant_id, 0);
  select * into v_old from tenant_rules
   where id = p_rule_id and tenant_id = p_tenant_id for update;
  if v_old.id is null or v_old.status not in ('active', 'suggested') then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_old.status = 'suggested' then
    perform _rules_lock_and_check_cap(p_tenant_id, 1);
  end if;
  update tenant_rules
     set status = case when v_old.status = 'active' then 'superseded' else 'dismissed' end,
         updated_at = now()
   where id = v_old.id;
  insert into tenant_rules (
    tenant_id, scope_kind, scope_slug, text, status, origin,
    suggested_by, created_by, approved_by, approved_at, supersedes
  ) values (
    p_tenant_id, p_scope_kind, p_scope_slug, v_text, 'active', 'rules_page',
    p_actor::text, p_actor, p_actor, now(), v_old.id
  ) returning id into v_id;
  return jsonb_build_object('status', 'active', 'rule_id', v_id, 'replaced', v_old.id);
end $$;
revoke all on function public.rule_edit(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.rule_edit(uuid, uuid, uuid, text, text, text) to service_role;

create or replace function public.rule_dismiss(p_tenant_id uuid, p_actor uuid, p_rule_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  update tenant_rules set status = 'dismissed', updated_at = now()
   where id = p_rule_id and tenant_id = p_tenant_id and status = 'suggested';
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', case when v_n = 1 then 'dismissed' else 'not_found' end);
end $$;
revoke all on function public.rule_dismiss(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rule_dismiss(uuid, uuid, uuid) to service_role;

create or replace function public.rule_delete(p_tenant_id uuid, p_actor uuid, p_rule_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  update tenant_rules
     set status = 'deleted', text = '', excerpt = null,
         source_start = null, source_end = null, updated_at = now()
   where id = p_rule_id and tenant_id = p_tenant_id and status <> 'deleted';
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', case when v_n = 1 then 'deleted' else 'not_found' end);
end $$;
revoke all on function public.rule_delete(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rule_delete(uuid, uuid, uuid) to service_role;

create or replace function public.rule_delete_all(p_tenant_id uuid, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  update tenant_rules
     set status = 'deleted', text = '', excerpt = null,
         source_start = null, source_end = null, updated_at = now()
   where tenant_id = p_tenant_id
     and (status <> 'deleted' or text <> '' or excerpt is not null);
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', 'deleted', 'count', v_n);
end $$;
revoke all on function public.rule_delete_all(uuid, uuid) from public, anon, authenticated;
grant execute on function public.rule_delete_all(uuid, uuid) to service_role;

create or replace function public.rule_set_suggestions_paused(p_tenant_id uuid, p_actor uuid, p_paused boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  insert into tenant_rule_settings (tenant_id, suggestions_paused, updated_by, updated_at)
  values (p_tenant_id, coalesce(p_paused, false), p_actor, now())
  on conflict (tenant_id) do update
    set suggestions_paused = excluded.suggestions_paused,
        updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('status', 'ok', 'paused', coalesce(p_paused, false));
end $$;
revoke all on function public.rule_set_suggestions_paused(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.rule_set_suggestions_paused(uuid, uuid, boolean) to service_role;

create or replace function public.rule_list(p_tenant_id uuid, p_actor uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_role    text := _rules_actor_role(p_tenant_id, p_actor);
  v_manager boolean := v_role in ('owner', 'admin');
begin
  return jsonb_build_object(
    'role', v_role,
    'suggestions_paused', coalesce((select suggestions_paused from tenant_rule_settings
                                     where tenant_id = p_tenant_id), false),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'scope_kind', r.scope_kind, 'scope_slug', r.scope_slug,
               'text', r.text, 'status', r.status, 'origin', r.origin,
               'suggested_by', r.suggested_by, 'created_by', r.created_by,
               'approved_by', r.approved_by, 'approved_at', r.approved_at,
               'supersedes', r.supersedes, 'created_at', r.created_at,
               'excerpt', case when v_manager or r.created_by = p_actor then r.excerpt end)
             order by r.status, coalesce(r.approved_at, r.created_at) desc, r.id)
        from tenant_rules r
       where r.tenant_id = p_tenant_id and r.status in ('active', 'suggested')
    ), '[]'::jsonb)
  );
end $$;
revoke all on function public.rule_list(uuid, uuid) from public, anon, authenticated;
grant execute on function public.rule_list(uuid, uuid) to service_role;

commit;
