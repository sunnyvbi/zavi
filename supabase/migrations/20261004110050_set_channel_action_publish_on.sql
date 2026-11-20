
create or replace function set_channel_action_publish_on(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_publish_on    date,
  p_actor_user_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row channel_actions%rowtype;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_actor_user_id is not null and not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'illegal_transition', 'from', v_row.status);
  end if;
  if jsonb_typeof(v_row.body->'step') is distinct from 'object' then
    return jsonb_build_object('ok', false, 'code', 'no_step');
  end if;

  update channel_actions
     set body = case
                  when p_publish_on is null then body #- '{step,publish_on}'
                  else jsonb_set(body, '{step,publish_on}', to_jsonb(to_char(p_publish_on, 'YYYY-MM-DD')), true)
                end
   where id = p_action_id;

  return jsonb_build_object('ok', true,
                            'publish_on', case when p_publish_on is null then null
                                               else to_char(p_publish_on, 'YYYY-MM-DD') end);
end $$;

revoke all on function set_channel_action_publish_on(uuid, uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function set_channel_action_publish_on(uuid, uuid, date, uuid) to service_role;
