
create table inbox_domain (
  domain      text primary key,
  status      text not null check (status in ('active', 'retired')) default 'active',
  created_at  timestamptz not null default now()
);

insert into inbox_domain (domain) values ('inbox.zaviagent.com')
on conflict (domain) do nothing;

create table inbox_handle_ledger (
  handle      text primary key,
  tenant_id   uuid references tenants(id) on delete set null,
  status      text not null check (status in ('active', 'released')) default 'active',
  minted_at   timestamptz not null default now(),
  released_at timestamptz
);
create unique index inbox_handle_ledger_active_tenant_uq
  on inbox_handle_ledger (tenant_id)
  where status = 'active' and tenant_id is not null;

comment on table inbox_handle_ledger is
  'Global no-reuse ledger for inbox handles. Rows are NEVER deleted - tenant deletion sets tenant_id null + status=released, permanently reserving the handle so a future tenant cannot mint it and capture the dead tenant''s mail (cross-tenant, E3).';

create table inbox_reserved_handle (handle text primary key);
insert into inbox_reserved_handle (handle) values
  ('postmaster'), ('abuse'), ('admin'), ('administrator'), ('hostmaster'),
  ('webmaster'), ('noreply'), ('no-reply'), ('bounce'), ('bounces'),
  ('mailer-daemon'), ('root'), ('security'), ('info'), ('zavi'), ('system')
on conflict (handle) do nothing;

create or replace function is_valid_inbox_handle(p_handle text)
returns boolean language sql immutable as $$
  select p_handle ~ '^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$'
$$;

alter table tenant_agent_email_identity drop constraint if exists tenant_agent_email_identity_domain_id_fkey;
alter table tenant_agent_email_identity drop constraint if exists tenant_agent_email_identity_domain_id_local_part_key;
drop index if exists tenant_agent_email_identity_tenant_idx;
alter table tenant_agent_email_identity drop column if exists domain_id;
alter table tenant_agent_email_identity drop column if exists local_part;

drop table if exists tenant_inbox_domain;

alter table tenant_agent_email_identity
  add column if not exists handle text,
  add column if not exists domain text not null default 'inbox.zaviagent.com';

alter table tenant_agent_email_identity
  alter column handle set not null,
  alter column agent_slug set default 'operator';

alter table tenant_agent_email_identity
  add constraint tenant_agent_email_identity_domain_fk
  foreign key (domain) references inbox_domain(domain);

alter table tenant_agent_email_identity
  add constraint tenant_agent_email_identity_handle_fk
  foreign key (handle) references inbox_handle_ledger(handle);

alter table tenant_agent_email_identity
  add constraint tenant_agent_email_identity_handle_valid
  check (is_valid_inbox_handle(handle));

create unique index tenant_agent_email_identity_one_active_per_tenant
  on tenant_agent_email_identity (tenant_id)
  where status = 'active';
create unique index tenant_agent_email_identity_address_uq
  on tenant_agent_email_identity (lower(handle), lower(domain));

create or replace function mint_inbox_handle(
  p_tenant_id uuid,
  p_desired   text,
  p_domain    text default 'inbox.zaviagent.com'
) returns table (handle text, address text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_base   text;
  v_try    text;
  v_suffix int := 0;
  v_handle text;
  v_addr   text;
begin
  select i.handle, i.reply_to_address into v_handle, v_addr
  from tenant_agent_email_identity i
  where i.tenant_id = p_tenant_id and i.status = 'active'
  limit 1;
  if v_handle is not null then
    handle := v_handle;
    address := v_addr;
    return next;
    return;
  end if;

  if not exists (select 1 from inbox_domain d where d.domain = p_domain and d.status = 'active') then
    raise exception 'inbox domain % is not active', p_domain;
  end if;

  v_base := lower(coalesce(p_desired, ''));
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := regexp_replace(v_base, '-{2,}', '-', 'g');
  v_base := regexp_replace(v_base, '(^-+|-+$)', '', 'g');
  v_base := left(v_base, 20);
  v_base := regexp_replace(v_base, '-+$', '', 'g');
  if length(v_base) < 3 or not is_valid_inbox_handle(v_base) then
    v_base := 'zv' || substr(replace(p_tenant_id::text, '-', ''), 1, 8);
  end if;

  loop
    exit when v_suffix > 500;
    v_try := case when v_suffix = 0 then v_base else left(v_base, 20) || v_suffix::text end;

    if is_valid_inbox_handle(v_try)
       and not exists (select 1 from inbox_reserved_handle r where r.handle = v_try)
    then
      begin
        insert into inbox_handle_ledger (handle, tenant_id, status)
        values (v_try, p_tenant_id, 'active');

        insert into tenant_agent_email_identity
          (tenant_id, agent_slug, handle, domain, reply_to_address, status)
        values
          (p_tenant_id, 'operator', v_try, p_domain, v_try || '@' || p_domain, 'active');

        handle := v_try;
        address := v_try || '@' || p_domain;
        return next;
        return;
      exception when unique_violation then
        null;
      end;
    end if;
    v_suffix := v_suffix + 1;
  end loop;

  raise exception 'could not mint an inbox handle for tenant %', p_tenant_id;
end $$;

revoke all on function mint_inbox_handle(uuid, text, text) from public;
revoke all on function mint_inbox_handle(uuid, text, text) from authenticated, anon;
grant execute on function mint_inbox_handle(uuid, text, text) to service_role;

create or replace function release_inbox_handle(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update tenant_agent_email_identity
     set status = 'retired', retired_at = now()
   where tenant_id = p_tenant_id and status = 'active';

  update inbox_handle_ledger
     set status = 'released', released_at = now()
   where tenant_id = p_tenant_id and status = 'active';
end $$;

revoke all on function release_inbox_handle(uuid) from public;
revoke all on function release_inbox_handle(uuid) from authenticated, anon;
grant execute on function release_inbox_handle(uuid) to service_role;

drop function if exists resolve_email_recipient(text);
create or replace function resolve_email_recipient(p_envelope_to text)
returns table (tenant_id uuid, agent_slug text, identity_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_addr   text := lower(btrim(coalesce(p_envelope_to, '')));
  v_local  text;
  v_domain text;
begin
  if v_addr = '' or (length(v_addr) - length(replace(v_addr, '@', ''))) <> 1 then
    return;
  end if;

  v_local  := split_part(v_addr, '@', 1);
  v_domain := split_part(v_addr, '@', 2);

  v_local := split_part(v_local, '+', 1);

  if v_local = '' or v_domain = '' then
    return;
  end if;

  return query
  select i.tenant_id, i.agent_slug, i.id
  from tenant_agent_email_identity i
  join inbox_handle_ledger l
    on l.handle = i.handle
   and l.tenant_id = i.tenant_id
   and l.status = 'active'
  join inbox_domain d
    on d.domain = i.domain
   and d.status = 'active'
  where lower(i.handle) = v_local
    and lower(i.domain) = v_domain
    and i.status = 'active'
  limit 1;
end $$;

revoke all on function resolve_email_recipient(text) from public;
revoke all on function resolve_email_recipient(text) from authenticated, anon;
grant execute on function resolve_email_recipient(text) to service_role;

create or replace function is_own_inbox_address(p_address text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from inbox_domain d
    where d.status = 'active'
      and lower(split_part(btrim(coalesce(p_address, '')), '@', 2)) = lower(d.domain)
  );
$$;

revoke all on function is_own_inbox_address(text) from public;
revoke all on function is_own_inbox_address(text) from authenticated, anon;
grant execute on function is_own_inbox_address(text) to service_role;

do $$
declare t record;
begin
  for t in select id, display_name, slug from tenants loop
    begin
      perform mint_inbox_handle(t.id, coalesce(nullif(btrim(t.display_name), ''), t.slug));
    exception when others then
      raise warning 'inbox handle backfill skipped for tenant %: %', t.id, sqlerrm;
    end;
  end loop;
end $$;

alter table inbox_domain enable row level security;
alter table inbox_handle_ledger enable row level security;
alter table inbox_reserved_handle enable row level security;

create policy inbox_handle_ledger_member_select on inbox_handle_ledger
  for select to authenticated
  using (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id = auth.uid()));

create policy inbox_domain_member_select on inbox_domain
  for select to authenticated using (true);
