
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zavi_ops') then
    create role zavi_ops login noinherit;
  end if;
end $$;

alter role zavi_ops set statement_timeout = '15s';
alter role zavi_ops set idle_in_transaction_session_timeout = '30s';
alter role zavi_ops set default_transaction_read_only = on;

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

create or replace view ops.agent_runs as
select
  id, tenant_id, agent_slug, trigger, status, enqueued_at, started_at, finished_at,
  case when pg_column_size(error) <= 2000 then error end as error,
  pg_column_size(error) as error_bytes,
  cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  model_used, channel_slug, custom_agent_id, parent_run_id, batch_id,
  pg_column_size(prompt_snapshot) as prompt_bytes,
  pg_column_size(raw_response_text) as raw_response_bytes,
  pg_column_size(tool_calls) as tool_calls_bytes,
  pg_column_size(parsed) as parsed_bytes,
  pg_column_size(reasoning_text) as reasoning_bytes,
  pg_column_size(output_text) as output_bytes,
  pg_column_size(payload) as payload_bytes,
  pg_column_size(outcome) as outcome_bytes
from public.agent_runs;

create or replace view ops.tenants as
select id, slug, display_name, kind, tier, created_at, deleted_at from public.tenants;

create or replace view ops.memory_note as
select id, tenant_id, note_type, source, trust_tier, agent_slug, created_at, archived_at,
       pg_column_size(body_markdown) as body_bytes
from public.memory_note;

revoke all on all tables in schema ops from public, anon, authenticated;
grant usage on schema ops to zavi_ops;
grant select on all tables in schema ops to zavi_ops;

commit;
