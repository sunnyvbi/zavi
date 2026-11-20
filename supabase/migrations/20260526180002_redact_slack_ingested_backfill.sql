
create or replace function slack_ingested_payload_update(
  p_id      uuid,
  p_payload jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update ingested_events
     set payload = p_payload
   where id = p_id
     and provider = 'slack';
end $$;

revoke all on function slack_ingested_payload_update(uuid, jsonb) from public, authenticated, anon;
grant execute on function slack_ingested_payload_update(uuid, jsonb) to service_role;
