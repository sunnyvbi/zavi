
alter table social_posts
  add column if not exists transport text not null default 'pipedream'
  check (transport in ('pipedream', 'native'));

create or replace function social_post_create(
  p_tenant_id     uuid,
  p_decision_id   uuid,
  p_agent_run_id  uuid,
  p_channel       text,
  p_app_slug      text,
  p_action_id     text,
  p_account_id    text,
  p_destination_id uuid,
  p_configured_props jsonb,
  p_snapshot      jsonb,
  p_snapshot_hash text,
  p_scheduled_at  timestamptz,
  p_idempotency_key text,
  p_transport     text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_channel is null or p_action_id is null
     or p_account_id is null or p_idempotency_key is null or p_snapshot_hash is null then
    raise exception 'social_post_create: required field missing' using errcode = '22023';
  end if;
  if p_transport is null or p_transport not in ('pipedream', 'native') then
    raise exception 'social_post_create: transport must be pipedream|native' using errcode = '22023';
  end if;
  insert into social_posts (
    tenant_id, decision_id, agent_run_id, channel, pipedream_app_slug,
    pipedream_action_id, account_id, destination_id, configured_props,
    approved_payload_snapshot, snapshot_hash, scheduled_at, idempotency_key,
    status, transport
  ) values (
    p_tenant_id, p_decision_id, p_agent_run_id, p_channel, p_app_slug,
    p_action_id, p_account_id, p_destination_id, coalesce(p_configured_props, '{}'::jsonb),
    p_snapshot, p_snapshot_hash, p_scheduled_at, p_idempotency_key,
    case when p_scheduled_at is null then 'approved' else 'scheduled' end,
    p_transport
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

revoke all on function social_post_create(uuid, uuid, uuid, text, text, text, text, uuid, jsonb, jsonb, text, timestamptz, text, text) from public;
grant execute on function social_post_create(uuid, uuid, uuid, text, text, text, text, uuid, jsonb, jsonb, text, timestamptz, text, text) to service_role;
