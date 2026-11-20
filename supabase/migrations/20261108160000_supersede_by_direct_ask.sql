
begin;

create or replace function supersede_channel_actions_by_direct_ask(
  p_tenant_id uuid,
  p_new_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new     channel_actions%rowtype;
  v_classes text[] := array['chatgpt_ads.create_and_launch', 'tiktok_ads.create_launch', 'meta_ads.launch_campaign',
                            'google_ads.create_campaign', 'x_ads.create_campaign', 'linkedin_ads.launch_campaign'];
  v_closed  jsonb := '[]'::jsonb;
  v_note    text;
  v_ids     uuid[] := '{}';
  v_id      uuid;
begin
  if p_tenant_id is null or p_new_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;
  select * into v_new from channel_actions where id = p_new_id and tenant_id = p_tenant_id;
  if v_new.id is null or v_new.exec_class is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':' || v_new.channel_slug, 0));

  v_note := left('Replaced by your direct ask: ' || v_new.title, 1000);

  perform 1
     from channel_actions
    where tenant_id = p_tenant_id
      and channel_slug = v_new.channel_slug
      and id <> p_new_id
      and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
      and (status in ('pending', 'snoozed') or exec_status in ('queued', 'dispatching'))
    order by id
    for update;

  select id into v_id
    from channel_actions
   where tenant_id = p_tenant_id
     and channel_slug = v_new.channel_slug
     and id <> p_new_id
     and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
     and (exec_status in ('queued', 'dispatching')
          or (exec_status = 'executed' and status in ('pending', 'snoozed')))
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', false, 'code', 'duplicate_in_flight', 'holder', v_id);
  end if;

  with retired as (
    update channel_actions
       set status = 'stale', status_at = now(), note = v_note
     where tenant_id = p_tenant_id
       and channel_slug = v_new.channel_slug
       and id <> p_new_id
       and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
       and status in ('pending', 'snoozed')
       and (exec_status is null
            or (exec_status = 'failed'
                and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
                and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
    returning id, title
  )
  select coalesce(array_agg(id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title)), '[]'::jsonb)
    into v_ids, v_closed
    from retired;

  foreach v_id in array v_ids
  loop
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (p_tenant_id, v_id, 'stale_flagged', 'system', v_new.run_id, v_note, 'direct_ask:' || p_new_id)
    on conflict (action_id, event_key) do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'superseded', to_jsonb(v_ids), 'closed', v_closed);
end $$;

revoke all on function supersede_channel_actions_by_direct_ask(uuid, uuid) from public, anon, authenticated;
grant execute on function supersede_channel_actions_by_direct_ask(uuid, uuid) to service_role;

commit;
