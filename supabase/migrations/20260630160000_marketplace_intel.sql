
create table marketplace_geo_category_weekly (
  tenant_id uuid not null,
  state text,
  geo_label text not null,
  week_start date not null,
  bookings_n int not null default 0,
  active_supply_n int not null default 0,
  gmv_proxy_n numeric,
  demand_basis text not null,
  supply_basis text not null,
  confidence text not null,
  suppressed boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (tenant_id, geo_label, week_start)
);

create table marketplace_intel_config (
  tenant_id uuid primary key,
  config jsonb not null,
  provenance jsonb,
  validated boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table marketplace_geo_category_weekly enable row level security;
create policy marketplace_geo_category_weekly_member_select on marketplace_geo_category_weekly
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = marketplace_geo_category_weekly.tenant_id)
  );

alter table marketplace_intel_config enable row level security;
create policy marketplace_intel_config_member_select on marketplace_intel_config
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = marketplace_intel_config.tenant_id)
  );

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
      computed_at
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
      coalesce((v_row->>'computed_at')::timestamptz, now())
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
          computed_at = excluded.computed_at;
  end loop;
end $$;

revoke all on function upsert_marketplace_rollup(uuid, jsonb) from public;
revoke all on function upsert_marketplace_rollup(uuid, jsonb) from anon;
revoke all on function upsert_marketplace_rollup(uuid, jsonb) from authenticated;
grant execute on function upsert_marketplace_rollup(uuid, jsonb) to service_role;

insert into marketplace_intel_config (
  tenant_id,
  config,
  provenance,
  validated
) values (
  '73db45ff-457e-4541-bc8f-bdb625390204',
  '{
    "bookings": {
      "table": "trips",
      "created_at_field": "createdAt",
      "geo_field": "carArea",
      "listing_ref_field": "carId",
      "gmv_proxy_field": null
    },
    "listings": {
      "table": "carlistings",
      "id_field": "_id",
      "status_field": "listingStatus",
      "bookable_status_values": ["Completed"]
    },
    "intent_events": {
      "search": null,
      "view": null,
      "contact": null
    }
  }'::jsonb,
  '{"source":"phase0_audit_2026-06","validated":true}'::jsonb,
  true
) on conflict (tenant_id) do update
  set config = excluded.config,
      provenance = excluded.provenance,
      validated = true,
      updated_at = now();
