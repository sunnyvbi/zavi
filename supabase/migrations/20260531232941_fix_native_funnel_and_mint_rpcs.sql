
create or replace function mint_tenant_ingest_key(
  p_tenant_id uuid,
  p_key_hash  text,
  p_label     text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_key_hash is null then
    raise exception 'mint_tenant_ingest_key: null argument' using errcode = '22023';
  end if;
  insert into tenant_ingest_keys (tenant_id, key_hash, label)
  values (p_tenant_id, p_key_hash, p_label)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function mint_tenant_ingest_key(uuid, text, text) from public;
grant execute on function mint_tenant_ingest_key(uuid, text, text) to service_role;

create or replace function get_native_funnel(
  p_tenant_id uuid,
  p_steps     text[],
  p_window    interval default interval '30 days'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_since        timestamptz;
  v_total_events bigint;
  v_step         text;
  v_count        bigint;
  v_first_count  bigint := null;
  v_steps        jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null then
    raise exception 'get_native_funnel: null tenant_id' using errcode = '22023';
  end if;
  if p_steps is null or array_length(p_steps, 1) is null then
    raise exception 'get_native_funnel: at least one step is required' using errcode = '22023';
  end if;
  if array_length(p_steps, 1) > 12 then
    raise exception 'get_native_funnel: too many steps (max 12)' using errcode = '22023';
  end if;

  v_since := now() - coalesce(p_window, interval '30 days');

  select count(*) into v_total_events
    from tenant_events
   where tenant_id = p_tenant_id
     and occurred_at >= v_since;

  if v_total_events = 0 then
    return jsonb_build_object(
      'has_data', false,
      'tenant_id', p_tenant_id,
      'window', p_window::text,
      'steps', '[]'::jsonb
    );
  end if;

  foreach v_step in array p_steps loop
    select count(distinct distinct_id) into v_count
      from tenant_events
     where tenant_id = p_tenant_id
       and event_name = v_step
       and occurred_at >= v_since
       and distinct_id is not null;

    if v_first_count is null then
      v_first_count := v_count;
    end if;

    v_steps := v_steps || jsonb_build_object(
      'event', v_step,
      'count', v_count,
      'conversion_from_top',
        case when v_first_count is null or v_first_count = 0 then null
             else round((v_count::numeric / v_first_count::numeric), 4) end
    );
  end loop;

  return jsonb_build_object(
    'has_data', true,
    'tenant_id', p_tenant_id,
    'window', p_window::text,
    'total_events_in_window', v_total_events,
    'steps', v_steps
  );
end $$;
revoke all on function get_native_funnel(uuid, text[], interval) from public;
grant execute on function get_native_funnel(uuid, text[], interval) to service_role;
