
ALTER TABLE memory_relation
  ADD COLUMN IF NOT EXISTS link_source text
    CHECK (link_source IS NULL OR link_source IN ('extracted','frontmatter','manual')),
  ADD COLUMN IF NOT EXISTS origin_field text
    CHECK (origin_field IS NULL OR length(origin_field) <= 64),
  ADD COLUMN IF NOT EXISTS context text
    CHECK (context IS NULL OR length(context) <= 240);

CREATE INDEX IF NOT EXISTS memory_relation_tenant_src_idx
  ON memory_relation (tenant_id, src_entity_id);

CREATE INDEX IF NOT EXISTS memory_relation_tenant_dst_idx
  ON memory_relation (tenant_id, dst_entity_id);

CREATE INDEX IF NOT EXISTS memory_relation_source_note_idx
  ON memory_relation (source_note_id)
  WHERE source_note_id IS NOT NULL;

ALTER TABLE memory_relation
  DROP CONSTRAINT IF EXISTS memory_relation_tenant_id_src_entity_id_dst_entity_id_rela_key;

ALTER TABLE memory_relation
  ADD CONSTRAINT memory_relation_provenance_key
    UNIQUE NULLS NOT DISTINCT
      (tenant_id, src_entity_id, dst_entity_id, relation_type, link_source, source_note_id);
