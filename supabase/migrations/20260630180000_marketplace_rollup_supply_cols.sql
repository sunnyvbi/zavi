
alter table marketplace_geo_category_weekly
  add column total_listings int,
  add column completed_listings int;

create or replace function upsert_marketplace_rollup(
  p_tenant uuid,
  p_rows jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb;
begin
  if p_tenant is null then
    raise exception 'upsert_marketplace_rollup: p_tenant required'
      using errcode = '22023';
  end if;

  if p_rows is null then
    return;
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'upsert_marketplace_rollup: p_rows must be a jsonb array'
      using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    if (v_row ? 'tenant_id') and (v_row->>'tenant_id')::uuid <> p_tenant then
      raise exception 'upsert_marketplace_rollup: row tenant_id does not match p_tenant'
        using errcode = '42501';
    end if;

    insert into marketplace_geo_category_weekly (
      tenant_id,
      state,
      geo_label,
      week_start,
      bookings_n,
      active_supply_n,
      gmv_proxy_n,
      demand_basis,
      supply_basis,
      confidence,
      suppressed,
      computed_at,
      total_listings,
      completed_listings
    ) values (
      p_tenant,
      nullif(v_row->>'state', ''),
      v_row->>'geo_label',
      (v_row->>'week_start')::date,
      coalesce((v_row->>'bookings_n')::int, 0),
      coalesce((v_row->>'active_supply_n')::int, 0),
      case
        when v_row ? 'gmv_proxy_n' and v_row->>'gmv_proxy_n' is not null
          then (v_row->>'gmv_proxy_n')::numeric
        else null
      end,
      v_row->>'demand_basis',
      v_row->>'supply_basis',
      v_row->>'confidence',
      coalesce((v_row->>'suppressed')::boolean, false),
      coalesce((v_row->>'computed_at')::timestamptz, now()),
      nullif(v_row->>'total_listings', '')::int,
      nullif(v_row->>'completed_listings', '')::int
    )
    on conflict (tenant_id, geo_label, week_start) do update
      set state = excluded.state,
          bookings_n = excluded.bookings_n,
          active_supply_n = excluded.active_supply_n,
          gmv_proxy_n = excluded.gmv_proxy_n,
          demand_basis = excluded.demand_basis,
          supply_basis = excluded.supply_basis,
          confidence = excluded.confidence,
          suppressed = excluded.suppressed,
          computed_at = excluded.computed_at,
          total_listings = excluded.total_listings,
          completed_listings = excluded.completed_listings;
  end loop;
end $$;

revoke all on function upsert_marketplace_rollup(uuid, jsonb) from public;
revoke all on function upsert_marketplace_rollup(uuid, jsonb) from anon;
revoke all on function upsert_marketplace_rollup(uuid, jsonb) from authenticated;
grant execute on function upsert_marketplace_rollup(uuid, jsonb) to service_role;
