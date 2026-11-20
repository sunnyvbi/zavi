

alter table tenant_config_audit
  alter column actor_user_id drop not null;

alter table tenant_config_audit
  drop constraint if exists tenant_config_audit_actor_or_system;

alter table tenant_config_audit
  add constraint tenant_config_audit_actor_or_system
  check (actor_user_id is not null or action like 'set-system%');

comment on column tenant_config_audit.actor_user_id is
  'User who made the change. NULL only for system-initiated writes, which must carry an '
  'action of set-system* (enforced by tenant_config_audit_actor_or_system). Was NOT NULL '
  'until 2026-07-13, which made set_tenant_product_url_system raise 23502 on every call and '
  'silently roll back every automated product_url write.';

do $$ begin
  create type tenant_fact_key as enum (
    'domain',
    'signup_url',
    'what_we_sell',
    'who_we_serve',
    'pricing_page'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type tenant_fact_source as enum (
    'human_confirmed',
    'typed_column',
    'connector',
    'onboarding_enrichment'
  );
exception when duplicate_object then null; end $$;

create table if not exists tenant_fact (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key         tenant_fact_key not null,
  value_text  text not null check (length(btrim(value_text)) between 1 and 500),
  source      tenant_fact_source not null,
  source_ref  text check (source_ref is null or length(source_ref) <= 500),
  verified_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists tenant_fact_tenant_key_uq
  on tenant_fact (tenant_id, key);

alter table tenant_fact enable row level security;

drop policy if exists tenant_fact_member_select on tenant_fact;
create policy tenant_fact_member_select on tenant_fact
  for select
  using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = tenant_fact.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on tenant_fact from anon, authenticated;

create or replace function set_tenant_fact(
  p_tenant_id  uuid,
  p_key        tenant_fact_key,
  p_value_text text,
  p_source     tenant_fact_source,
  p_source_ref text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev text;
begin
  select value_text into v_prev
    from tenant_fact
   where tenant_id = p_tenant_id and key = p_key;

  insert into tenant_fact (tenant_id, key, value_text, source, source_ref, verified_at, updated_at)
  values (p_tenant_id, p_key, btrim(p_value_text), p_source, p_source_ref, now(), now())
  on conflict (tenant_id, key) do update
    set value_text  = excluded.value_text,
        source      = excluded.source,
        source_ref  = excluded.source_ref,
        verified_at = now(),
        updated_at  = now();

  insert into tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values (p_tenant_id, null, 'set-system', 'tenant_fact.' || p_key::text, v_prev, btrim(p_value_text));
end $$;

revoke execute on function set_tenant_fact(uuid, tenant_fact_key, text, tenant_fact_source, text)
  from public, anon, authenticated;
grant execute on function set_tenant_fact(uuid, tenant_fact_key, text, tenant_fact_source, text)
  to service_role;

comment on function set_tenant_fact is
  'ONLY write path for tenant_fact. service_role only — agents hold no grant and therefore '
  'cannot poison the resident company fact sheet. verified_at always advances on write.';
