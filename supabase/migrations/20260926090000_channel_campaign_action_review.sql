create or replace function public.prepare_channel_campaign_action(
  p_tenant_id uuid, p_action_id uuid, p_actor_user_id uuid,
  p_expected_body jsonb, p_payload jsonb, p_exact_change jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row channel_actions%rowtype;
begin
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id
     or v_row.channel_slug <> 'chatgpt_ads' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id
    and user_id = p_actor_user_id and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_class is not null then
    return jsonb_build_object('ok',
      v_row.exec_class = 'chatgpt_ads.create_campaign_bundle' and v_row.exec_payload = p_payload,
      'replayed', true);
  end if;
  if v_row.status <> 'pending' or v_row.exec_status is not null
     or v_row.body is distinct from p_expected_body
     or v_row.body #>> '{step,responsibility}' is distinct from 'client'
     or v_row.body #>> '{step,deliverable,presentation,type}' is distinct from 'campaign_draft'
     or jsonb_typeof(p_payload) is distinct from 'object'
     or jsonb_typeof(p_exact_change->'rows') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'action_changed');
  end if;
  update channel_actions set
    exec_class = 'chatgpt_ads.create_campaign_bundle', exec_payload = p_payload,
    action_type = 'create_ad', card_kind = 'executes', primary_label = 'Create paused campaign',
    done_label = 'Done', how_to = '["Review the approved budget, targeting and ads.", "Press Create paused campaign. Zavi creates the campaign, group and ads, all paused."]'::jsonb,
    body = body || jsonb_build_object('exact_change', p_exact_change)
  where id = p_action_id;
  insert into channel_action_events (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
    values (p_tenant_id, p_action_id, 'revised', 'founder', p_actor_user_id, 'campaign-reviewed:' || p_action_id);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.prepare_channel_campaign_action(uuid,uuid,uuid,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.prepare_channel_campaign_action(uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
