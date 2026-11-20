create unique index if not exists memory_note_skill_source_ref_uniq
  on memory_note (tenant_id, source_ref)
  where note_type = 'skill' and source_ref is not null and superseded_by is null;
