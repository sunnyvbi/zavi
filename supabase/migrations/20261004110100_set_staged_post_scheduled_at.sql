
create or replace function set_staged_post_scheduled_at(
  p_tenant_id     uuid,
  p_decision_id   uuid,
  p_scheduled_at  timestamptz,
  p_actor_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row decisions%rowtype;
  v_at  jsonb;
begin
  if p_tenant_id is null or p_decision_id is null or p_actor_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_row from decisions where id = p_decision_id for update;
  if not found
     or v_row.tenant_id is distinct from p_tenant_id
     or v_row.decision_class is distinct from 'social.publish.v2' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.status is distinct from 'proposed' or v_row.superseded_at is not null then
    return jsonb_build_object('ok', false, 'code', 'not_pending', 'status', v_row.status);
  end if;

  v_at := case when p_scheduled_at is null then 'null'::jsonb
               else to_jsonb(to_char(p_scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) end;

  update decisions
     set body = jsonb_set(coalesce(body, '{}'::jsonb), '{scheduled_at}', v_at, true)
   where id = p_decision_id;

  return jsonb_build_object('ok', true, 'scheduled_at', v_at);
end $$;

revoke all on function set_staged_post_scheduled_at(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function set_staged_post_scheduled_at(uuid, uuid, timestamptz, uuid) to service_role;
