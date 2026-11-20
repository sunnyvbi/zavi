
begin;

alter table memory_note
  add column custom_agent_id uuid references custom_agents(id) on delete set null,
  add column run_id uuid references agent_runs(id) on delete set null;

create or replace function delete_custom_agent_note(
  p_tenant_id uuid, p_agent_id uuid, p_note_id uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_note memory_note;
begin
  perform _custom_agent_authorize(p_tenant_id);
  delete from memory_note
   where id = p_note_id
     and tenant_id = p_tenant_id
     and custom_agent_id = p_agent_id
     and custom_agent_id is not null
     and slug is null
  returning * into v_note;
  if not found then
    return false;
  end if;
  insert into memory_mutation_audit (tenant_id, note_id, actor_user_id, action, reason, before_snapshot)
  values (
    p_tenant_id,
    v_note.id,
    auth.uid(),
    'delete',
    'Deleted from the custom agent''s Agent Builder page',
    jsonb_build_object(
      'redaction',    'rtbf_delete',
      'note_id',      v_note.id,
      'title_sha256', left(encode(sha256(convert_to(coalesce(v_note.title, ''), 'UTF8')), 'hex'), 16),
      'source',       v_note.source,
      'note_type',    v_note.note_type,
      'trust_tier',   v_note.trust_tier,
      'created_at',   v_note.created_at,
      'updated_at',   v_note.updated_at
    )
  );
  return true;
end $$;

revoke all on function delete_custom_agent_note(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function delete_custom_agent_note(uuid, uuid, uuid) to authenticated, service_role;

commit;
