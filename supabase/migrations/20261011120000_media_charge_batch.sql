
alter table public.generative_video_jobs add column if not exists pending_charges jsonb;

create or replace function public.charge_media_credits_batch(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_items     jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item jsonb;
  v_out  jsonb := '{}'::jsonb;
begin
  if p_tenant_id is null then
    raise exception 'charge_media_credits_batch: tenant_id required' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 200 then
    raise exception 'charge_media_credits_batch: items must be a non-empty array of at most 200' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(length(v_item->>'key'), 0) = 0
       or jsonb_typeof(v_item->'cost_usd') <> 'number' then
      raise exception 'charge_media_credits_batch: invalid item' using errcode = '22023';
    end if;
  end loop;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_out := v_out || jsonb_build_object(
      v_item->>'key',
      public.charge_media_credits(p_tenant_id, v_item->>'key', (v_item->>'cost_usd')::numeric, v_item->>'task', v_item->>'model', p_run_id)
    );
  end loop;
  return v_out;
end $$;
revoke all on function public.charge_media_credits_batch(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.charge_media_credits_batch(uuid, uuid, jsonb) to service_role;
