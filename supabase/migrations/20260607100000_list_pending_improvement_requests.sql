
create or replace function list_pending_improvement_requests(
  p_limit int default 20
) returns table (
  id                bigint,
  tenant_id         uuid,
  agent_slug        text,
  cluster_signature text,
  run_ids           uuid[],
  digest_reason     text,
  "window"          text
)
language plpgsql security definer set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 200);
begin
  return query
  with claimed as (
    select air.id
      from agent_improvement_requests air
     where air.status = 'pending'
     order by air.created_at asc
     limit v_limit
     for update skip locked
  )
  update agent_improvement_requests air
     set status     = 'leased',
         leased_at  = now(),
         leased_by  = 'self-improve-runner',
         updated_at = now()
    from claimed
   where air.id = claimed.id
  returning
    air.id,
    air.tenant_id,
    air.agent_slug,
    air.cluster_signature,
    air.run_ids,
    air.digest_reason,
    air."window";
end $$;

revoke all on function list_pending_improvement_requests(int) from public;
revoke all on function list_pending_improvement_requests(int) from authenticated;
grant execute on function list_pending_improvement_requests(int) to service_role;
