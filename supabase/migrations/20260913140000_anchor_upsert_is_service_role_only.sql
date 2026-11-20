
begin;

revoke execute on function memory_note_upsert_anchor(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function memory_note_upsert_anchor(uuid, text, text, text, text, jsonb)
  to service_role;

revoke execute on function memory_note_upsert_anchor(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function memory_note_upsert_anchor(uuid, text, text, text, text)
  to service_role;

commit;
