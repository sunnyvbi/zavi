create or replace function release_channel_action_exec_claim(
  p_action_id uuid,
  p_claim_id  uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_action_id is null or p_claim_id is null then
    return false;
  end if;
  update channel_actions
     set exec_status     = 'queued',
         exec_claim_id   = null,
         exec_claimed_at = null
   where id = p_action_id
     and exec_status = 'dispatching'
     and exec_claim_id = p_claim_id;
  return found;
end $$;

revoke all on function release_channel_action_exec_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function release_channel_action_exec_claim(uuid, uuid) to service_role;
