begin;
alter function code_index_insert_chunk(uuid, text, uuid, text, timestamptz, jsonb, jsonb)
  set statement_timeout = '180s';
alter function code_index_commit(uuid, text, uuid, text)
  set statement_timeout = '180s';
commit;
