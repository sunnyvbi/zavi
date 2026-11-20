
create table if not exists app_setting (
  key text primary key,
  value jsonb not null,
  value_type text not null default 'boolean',
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists tenant_app_setting (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (tenant_id, key)
);
create index if not exists tenant_app_setting_key_idx on tenant_app_setting (key);

alter table app_setting enable row level security;
alter table tenant_app_setting enable row level security;

insert into app_setting (key, value, value_type, description)
values
  ('memory_reranker_enabled',
   coalesce((select blob->'memory_reranker_enabled_default' from system_config where id = 1), 'true'::jsonb),
   'boolean', 'Two-stage Voyage rerank-2.5 over a widened OR pool in hybrid search.'),
  ('brain_eval_salience',
   coalesce((select blob->'brain_eval_salience_default' from system_config where id = 1), 'false'::jsonb),
   'boolean', 'Salience boost in hybrid-search ranking.'),
  ('brain_eval_recency',
   coalesce((select blob->'brain_eval_recency_default' from system_config where id = 1), 'false'::jsonb),
   'boolean', 'Recency-decay boost in hybrid-search ranking.'),
  ('brain_eval_backlink_boost',
   coalesce((select blob->'brain_eval_backlink_boost_default' from system_config where id = 1), 'false'::jsonb),
   'boolean', 'Backlink in-degree boost in hybrid-search ranking.'),
  ('brain_eval_patterns',
   coalesce((select blob->'brain_eval_patterns_default' from system_config where id = 1), 'false'::jsonb),
   'boolean', 'Pattern-note ingestion + boost.'),
  ('brain_gap_distill',
   coalesce((select blob->'brain_gap_distill_default' from system_config where id = 1), 'false'::jsonb),
   'boolean', 'Write knowledge-gap notes from failed-run signals (global only).'),
  ('brain_outcome_boost',
   coalesce((select blob->'brain_outcome_boost_default' from system_config where id = 1), 'false'::jsonb),
   'boolean', 'Boost/penalize notes by accepted/rejected run outcome (global only).')
on conflict (key) do nothing;

insert into tenant_app_setting (tenant_id, key, value)
select id, 'memory_reranker_enabled', to_jsonb(memory_reranker_enabled)
  from tenants where memory_reranker_enabled is not null
on conflict (tenant_id, key) do nothing;

insert into tenant_app_setting (tenant_id, key, value)
select id, 'brain_eval_salience', to_jsonb(brain_eval_salience)
  from tenants where brain_eval_salience is not null
on conflict (tenant_id, key) do nothing;

insert into tenant_app_setting (tenant_id, key, value)
select id, 'brain_eval_recency', to_jsonb(brain_eval_recency)
  from tenants where brain_eval_recency is not null
on conflict (tenant_id, key) do nothing;

insert into tenant_app_setting (tenant_id, key, value)
select id, 'brain_eval_backlink_boost', to_jsonb(brain_eval_backlink_boost)
  from tenants where brain_eval_backlink_boost is not null
on conflict (tenant_id, key) do nothing;

insert into tenant_app_setting (tenant_id, key, value)
select id, 'brain_eval_patterns', to_jsonb(brain_eval_patterns)
  from tenants where brain_eval_patterns is not null
on conflict (tenant_id, key) do nothing;
