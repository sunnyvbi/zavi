
CREATE TABLE IF NOT EXISTS eval_candidates (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_name           text NOT NULL CHECK (tool_name IN ('search','query')),
  query               text NOT NULL CHECK (length(query) <= 51200),
  retrieved_chunk_ids uuid[] NOT NULL DEFAULT '{}',
  retrieved_note_ids  uuid[] NOT NULL DEFAULT '{}',
  latency_ms          integer NOT NULL CHECK (latency_ms >= 0 AND latency_ms < 600000),
  k                   integer NOT NULL CHECK (k > 0 AND k <= 50),
  run_id              uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_slug          text CHECK (agent_slug IS NULL OR length(agent_slug) <= 200),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_candidates_tenant_created_idx
  ON eval_candidates (tenant_id, created_at DESC);

ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS eval_capture_failures (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id uuid,
  ts        timestamptz NOT NULL DEFAULT now(),
  reason    text NOT NULL CHECK (reason IN (
    'db_down','rls_reject','check_violation','scrubber_exception','other'
  )),
  detail    text
);

CREATE INDEX IF NOT EXISTS eval_capture_failures_ts_idx
  ON eval_capture_failures (ts DESC);

ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;
