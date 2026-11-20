
CREATE TABLE IF NOT EXISTS takes (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  holder_type         text NOT NULL CHECK (holder_type IN ('tenant','agent','user','entity')),
  holder_ref          text,
  kind                text NOT NULL CHECK (kind IN ('fact','take','bet','hunch')),
  subject_entity_id   uuid REFERENCES memory_entity(id) ON DELETE SET NULL,
  claim               text NOT NULL CHECK (length(claim) BETWEEN 1 AND 1000),
  weight              numeric(3,2) NOT NULL CHECK (weight >= 0 AND weight <= 1),
  source_note_id      uuid REFERENCES memory_note(id) ON DELETE SET NULL,
  source_run_id       uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  resolved_at         timestamptz,
  resolved_to         text CHECK (resolved_to IS NULL OR resolved_to IN ('correct','incorrect','partial')),
  resolved_by_user_id uuid,
  resolution_note     text CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  resolution_source   text CHECK (resolution_source IS NULL OR resolution_source IN ('manual','staff','auto','agent_self_reported')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT takes_holder_invariant CHECK (
    (holder_type = 'tenant' AND holder_ref IS NULL) OR
    (holder_type IN ('agent','user','entity') AND holder_ref IS NOT NULL AND length(holder_ref) <= 200)
  ),
  CONSTRAINT takes_resolution_only_for_bets CHECK (
    (resolved_to IS NULL AND resolved_at IS NULL) OR
    (kind = 'bet' AND resolved_to IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS takes_tenant_holder_idx
  ON takes (tenant_id, holder_type, holder_ref);

CREATE INDEX IF NOT EXISTS takes_tenant_kind_created_idx
  ON takes (tenant_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS takes_tenant_subject_idx
  ON takes (tenant_id, subject_entity_id)
  WHERE subject_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS takes_tenant_resolved_bets_created_idx
  ON takes (tenant_id, created_at DESC, holder_type, holder_ref)
  WHERE kind = 'bet' AND resolved_to IS NOT NULL;

ALTER TABLE takes ENABLE ROW LEVEL SECURITY;
