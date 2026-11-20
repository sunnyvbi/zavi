
create table if not exists tenant_email_allowlist (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references tenants(id) on delete cascade,
  kind       text        not null check (kind in ('address', 'domain')),
  value      text        not null,
  created_by uuid        not null,
  created_at timestamptz not null default now(),
  constraint tenant_email_allowlist_value_shape check (
    (kind = 'address' and value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    or
    (kind = 'domain' and value ~ '^[^@[:space:]]+\.[^@[:space:]]+$')
  )
);

create unique index if not exists tenant_email_allowlist_uq
  on tenant_email_allowlist (tenant_id, kind, lower(value));

alter table tenant_email_allowlist enable row level security;

create policy tenant_email_allowlist_member_select on tenant_email_allowlist
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = tenant_email_allowlist.tenant_id
    )
  );

revoke all on tenant_email_allowlist from public;

comment on table tenant_email_allowlist is
  'Per-tenant senders allowed to email the agent inbox in addition to workspace members. An empty list = members-only (the pre-2026-07-16 behavior). NEVER a substitute for DKIM/DMARC authenticity, which is checked first and cannot be bypassed by an entry.';

create or replace function list_email_allowlist()
returns table (id uuid, kind text, value text, created_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  v_tenant_id := public.app_active_tenant();
  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  if not exists (
    select 1 from public.tenant_users tu
    where tu.user_id = v_user_id and tu.tenant_id = v_tenant_id
  ) then
    raise exception 'no_tenant_membership';
  end if;

  return query
    select a.id, a.kind, a.value, a.created_at
    from public.tenant_email_allowlist a
    where a.tenant_id = v_tenant_id
    order by a.kind, a.value;
end $$;

revoke all on function list_email_allowlist() from public;
grant execute on function list_email_allowlist() to authenticated;
grant execute on function list_email_allowlist() to service_role;

comment on function list_email_allowlist() is
  'Settings read: the calling member''s tenant allowlist. Tenant is re-derived from the session, never supplied.';

create or replace function add_email_allowlist_entry(p_kind text, p_value text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_role      text;
  v_id        uuid;
  c_max       constant int := 50;
  v_count     int;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  v_tenant_id := public.app_active_tenant();
  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  select tu.role into v_role
    from public.tenant_users tu
   where tu.user_id = v_user_id and tu.tenant_id = v_tenant_id;

  if v_role is null then
    raise exception 'no_tenant_membership';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'admin_only';
  end if;

  if p_kind not in ('address', 'domain') then
    raise exception 'bad_kind';
  end if;

  if coalesce(btrim(p_value), '') = '' then
    raise exception 'bad_value';
  end if;

  select count(*) into v_count
    from public.tenant_email_allowlist a
   where a.tenant_id = v_tenant_id;
  if v_count >= c_max then
    raise exception 'allowlist_cap_reached';
  end if;

  insert into public.tenant_email_allowlist (tenant_id, kind, value, created_by)
  values (v_tenant_id, p_kind, lower(btrim(p_value)), v_user_id)
  on conflict (tenant_id, kind, lower(value)) do nothing
  returning id into v_id;

  if v_id is null then
    select a.id into v_id
      from public.tenant_email_allowlist a
     where a.tenant_id = v_tenant_id
       and a.kind = p_kind
       and lower(a.value) = lower(btrim(p_value));
  end if;

  return v_id;
end $$;

revoke all on function add_email_allowlist_entry(text, text) from public;
grant execute on function add_email_allowlist_entry(text, text) to authenticated;
grant execute on function add_email_allowlist_entry(text, text) to service_role;

comment on function add_email_allowlist_entry(text, text) is
  'Settings write (OWNER ONLY): add a sender/domain that may email this tenant''s agent. Tenant re-derived from the session. Never bypasses DKIM/DMARC — see src/email/sender-auth.ts.';

create or replace function remove_email_allowlist_entry(p_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_role      text;
  v_deleted   int;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  v_tenant_id := public.app_active_tenant();
  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  select tu.role into v_role
    from public.tenant_users tu
   where tu.user_id = v_user_id and tu.tenant_id = v_tenant_id;

  if v_role is null then
    raise exception 'no_tenant_membership';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'admin_only';
  end if;

  delete from public.tenant_email_allowlist a
   where a.id = p_id
     and a.tenant_id = v_tenant_id;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end $$;

revoke all on function remove_email_allowlist_entry(uuid) from public;
grant execute on function remove_email_allowlist_entry(uuid) to authenticated;
grant execute on function remove_email_allowlist_entry(uuid) to service_role;

comment on function remove_email_allowlist_entry(uuid) is
  'Settings write (OWNER ONLY): remove an allowlist entry. Foreign ids delete nothing and are indistinguishable from missing ones.';

create or replace function email_allowlist_entries(p_tenant_id uuid)
returns table (kind text, value text)
language sql stable security definer
set search_path = public, pg_temp as $$
  select a.kind, a.value
  from public.tenant_email_allowlist a
  where a.tenant_id = p_tenant_id;
$$;

revoke all on function email_allowlist_entries(uuid) from public;
revoke all on function email_allowlist_entries(uuid) from authenticated, anon;
grant execute on function email_allowlist_entries(uuid) to service_role;

comment on function email_allowlist_entries(uuid) is
  'AgentMail internal: this tenant''s allowlist, for the inbound gate + the outbound reply audience. Both directions MUST use the same matcher (src/email/allowlist.ts) — if they disagree, a sender is either stranded or told something the inbound gate would have refused.';
