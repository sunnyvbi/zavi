
create table tenant_connector_skill (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  fact_key text not null,
  fact_text text not null,
  kind text not null,
  hits int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  constraint tenant_connector_skill_uq unique (tenant_id, provider, fact_key)
);

create index tenant_connector_skill_read_idx
  on tenant_connector_skill (tenant_id, provider, hits desc);

alter table tenant_connector_skill enable row level security;

create policy tenant_connector_skill_member_select on tenant_connector_skill
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = tenant_connector_skill.tenant_id)
  );

create or replace function record_connector_skill_facts(
  p_tenant_id uuid,
  p_provider text,
  p_facts jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_written int;
begin
  if p_tenant_id is null or p_provider is null or p_provider = '' then
    return 0;
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'array' then
    return 0;
  end if;

  insert into tenant_connector_skill
    (tenant_id, provider, fact_key, fact_text, kind)
  select
    p_tenant_id,
    left(p_provider, 64),
    left(f.key, 200),
    left(f.text, 500),
    left(coalesce(f.kind, 'tool_used'), 32)
  from jsonb_to_recordset(p_facts) as f(key text, text text, kind text)
  where f.key is not null and f.key <> ''
    and f.text is not null and f.text <> ''
  on conflict (tenant_id, provider, fact_key)
  do update set
    hits = tenant_connector_skill.hits + 1,
    last_seen = now(),
    fact_text = excluded.fact_text,
    kind = excluded.kind;

  get diagnostics v_written = row_count;
  return v_written;
end $$;

revoke all on function record_connector_skill_facts(uuid, text, jsonb)
  from public, authenticated, anon;
grant execute on function record_connector_skill_facts(uuid, text, jsonb)
  to service_role;
