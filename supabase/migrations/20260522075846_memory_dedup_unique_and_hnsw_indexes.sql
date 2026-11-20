create unique index if not exists memory_note_content_hash_uniq
  on memory_note (tenant_id, content_hash)
  where slug is null and superseded_by is null;

create index if not exists memory_chunk_embedding_hnsw
  on memory_chunk using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
