
create or replace function finalize_improvement_request(
  p_request_id bigint,
  p_status     text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_updated int;
begin
  if p_status is null or p_status not in ('surfaced', 'done', 'skipped') then
    raise exception 'finalize_improvement_request: invalid terminal status %', p_status
      using errcode = '22023';
  end if;

  update agent_improvement_requests
     set status     = p_status,
         updated_at = now()
   where id = p_request_id
     and status = 'leased';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

revoke all on function finalize_improvement_request(bigint, text) from public;
revoke all on function finalize_improvement_request(bigint, text) from authenticated;
grant execute on function finalize_improvement_request(bigint, text) to service_role;

create or replace function reap_stale_improvement_leases(
  p_ttl_minutes int default 120
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ttl    int := greatest(coalesce(p_ttl_minutes, 120), 1);
  v_reaped int;
begin
  update agent_improvement_requests
     set status     = 'pending',
         leased_at  = null,
         leased_by  = null,
         updated_at = now()
   where status = 'leased'
     and leased_at is not null
     and leased_at < now() - make_interval(mins => v_ttl);

  get diagnostics v_reaped = row_count;
  return v_reaped;
end $$;

revoke all on function reap_stale_improvement_leases(int) from public;
revoke all on function reap_stale_improvement_leases(int) from authenticated;
grant execute on function reap_stale_improvement_leases(int) to service_role;
