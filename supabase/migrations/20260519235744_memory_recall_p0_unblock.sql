
drop index if exists memory_chunk_embedding_idx;

update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{memory_index_kind}', '"none"'::jsonb),
    updated_at = now()
where id = 1;

create table if not exists memory_search_trace (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid,
  agent_slug text,
  query_hash text not null,
  query_l2_norm numeric,
  query_length int,
  lex_candidates int default 0,
  vec_candidates int default 0,
  fused_count int default 0,
  returned_count int default 0,
  latency_ms int not null,
  status text not null default 'ok',
  error_code text,
  embedding_model text,
  embedding_dim int,
  retrieval_mode text,
  fallback_reason text,
  index_kind text,
  visibility_decision text,
  matched_channels text[],
  rank_components jsonb,
  policy_version text,
  created_at timestamptz not null default now()
);
create index memory_search_trace_tenant_created_idx on memory_search_trace (tenant_id, created_at desc);
create index memory_search_trace_status_idx on memory_search_trace (tenant_id, status, created_at desc) where status != 'ok';
alter table memory_search_trace enable row level security;
create policy memory_search_trace_tenant_read on memory_search_trace
  for select using (tenant_id = current_setting('app.tenant_id', true)::uuid);

create table if not exists memory_recall_golden (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category text not null,
  query text not null,
  expected_note_ids uuid[] not null,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memory_recall_golden_tenant_active_idx on memory_recall_golden (tenant_id, active) where active;

create table if not exists memory_recall_eval_run (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ran_at timestamptz not null default now(),
  queries_run int not null,
  top3_recall numeric not null,
  mrr numeric not null,
  cross_tenant_hits int not null default 0,
  failures jsonb,
  alarmed boolean not null default false
);
create index memory_recall_eval_run_tenant_ran_idx on memory_recall_eval_run (tenant_id, ran_at desc);

