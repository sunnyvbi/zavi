
alter table tenant_connector_skill
  add column if not exists last_run_id uuid;

drop function if exists record_connector_skill_facts(uuid, text, jsonb);

create or replace function record_connector_skill_facts(
  p_tenant_id uuid,
  p_provider text,
  p_facts jsonb,
  p_run_id uuid default null
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
    (tenant_id, provider, fact_key, fact_text, kind, last_run_id)
  select
    p_tenant_id,
    left(p_provider, 64),
    left(f.key, 200),
    left(f.text, 500),
    left(coalesce(f.kind, 'tool_used'), 32),
    p_run_id
  from jsonb_to_recordset(p_facts) as f(key text, text text, kind text)
  where f.key is not null and f.key <> ''
    and f.text is not null and f.text <> ''
  on conflict (tenant_id, provider, fact_key)
  do update set
    hits = tenant_connector_skill.hits
      + case
          when excluded.last_run_id is null then 1
          when tenant_connector_skill.last_run_id is distinct from excluded.last_run_id then 1
          else 0
        end,
    last_seen = now(),
    fact_text = excluded.fact_text,
    kind = excluded.kind,
    last_run_id = excluded.last_run_id;

  get diagnostics v_written = row_count;
  return v_written;
end $$;

revoke all on function record_connector_skill_facts(uuid, text, jsonb, uuid)
  from public, authenticated, anon;
grant execute on function record_connector_skill_facts(uuid, text, jsonb, uuid)
  to service_role;
