
grant select on social_posts to authenticated;

create index if not exists social_posts_tenant_scheduled_idx
  on social_posts (tenant_id, scheduled_at);

create or replace function social_post_cancel(
  p_tenant_id uuid,
  p_post_id uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from social_posts
   where id = p_post_id and tenant_id = p_tenant_id
     and status in ('approved','scheduled')
   for update;
  if not found then
    return false;
  end if;
  update social_posts set status = 'cancelled' where id = p_post_id;
  return true;
end $$;

create or replace function social_post_reschedule(
  p_tenant_id uuid,
  p_post_id uuid,
  p_scheduled_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old social_posts%rowtype;
  v_when text;
  v_snapshot jsonb;
  v_new_id uuid;
begin
  if p_scheduled_at is null or p_scheduled_at <= now() then
    raise exception 'social_post_reschedule: p_scheduled_at must be in the future'
      using errcode = '22023';
  end if;

  select * into v_old from social_posts
   where id = p_post_id and tenant_id = p_tenant_id
     and status in ('approved','scheduled')
   for update;
  if not found then
    return null;
  end if;

  update social_posts set status = 'cancelled' where id = v_old.id;

  v_when := to_char(p_scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_snapshot := coalesce(v_old.approved_payload_snapshot, '{}'::jsonb)
             || jsonb_build_object('scheduled_at', v_when);

  insert into social_posts (
    tenant_id, decision_id, agent_run_id, channel,
    pipedream_app_slug, pipedream_action_id, account_id, destination_id,
    configured_props, approved_payload_snapshot, snapshot_hash,
    scheduled_at, status, idempotency_key, transport
  ) values (
    v_old.tenant_id, v_old.decision_id, v_old.agent_run_id, v_old.channel,
    v_old.pipedream_app_slug, v_old.pipedream_action_id, v_old.account_id, v_old.destination_id,
    v_old.configured_props, v_snapshot,
    encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'),
    p_scheduled_at, 'scheduled',
    encode(sha256(convert_to(v_old.idempotency_key || ':' || v_when, 'UTF8')), 'hex'),
    v_old.transport
  )
  returning id into v_new_id;

  return v_new_id;
end $$;

revoke all on function social_post_cancel(uuid, uuid) from public;
grant execute on function social_post_cancel(uuid, uuid) to service_role;
revoke all on function social_post_reschedule(uuid, uuid, timestamptz) from public;
grant execute on function social_post_reschedule(uuid, uuid, timestamptz) to service_role;
