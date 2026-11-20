begin;

create or replace function retire_cleared_geo_cards(
  p_tenant_id  uuid,
  p_action_ids uuid[],
  p_read_at    timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_note  constant text :=
    'Closed: Zavi''s latest read of your site no longer finds this problem, so there is nothing to do here.';
  v_stale uuid[] := '{}';
  v_id    uuid;
begin
  if p_tenant_id is null or p_read_at is null or coalesce(cardinality(p_action_ids), 0) = 0 then
    return jsonb_build_object('ok', true, 'stale', '[]'::jsonb);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':geo', 0));

  with retired as (
    update channel_actions c
       set status = 'stale', status_at = now(), note = v_note
     where c.id = any(p_action_ids)
       and c.tenant_id = p_tenant_id
       and c.channel_slug = 'geo'
       and c.proposed_at < p_read_at
       and c.status = 'pending'
       and c.exec_status is null
       and c.exec_class is null
       and c.approved_by is null
       and c.edited_body is null
       and coalesce(c.steps_done, '[]'::jsonb) = '[]'::jsonb
    returning c.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_stale from retired;

  foreach v_id in array v_stale
  loop
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, note, event_key)
    values
      (p_tenant_id, v_id, 'stale_flagged', 'system', v_note, 'geo_cleared:' || p_read_at::text)
    on conflict (action_id, event_key) do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'stale', to_jsonb(v_stale));
end $$;

revoke all on function retire_cleared_geo_cards(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function retire_cleared_geo_cards(uuid, uuid[], timestamptz) to service_role;

commit;
