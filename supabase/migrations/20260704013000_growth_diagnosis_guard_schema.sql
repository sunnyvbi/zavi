

alter table tenant_db_catalog add column if not exists catalog_hash text;

update tenant_db_catalog
   set catalog_hash = md5(
         dialect::text
         || coalesce(catalog, '{}'::jsonb)::text
         || coalesce(hints,   '{}'::jsonb)::text
       )
 where catalog_hash is null;

create or replace function set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_catalog jsonb := coalesce(p_catalog, '{}'::jsonb);
  v_hints   jsonb := coalesce(p_hints,   '{}'::jsonb);
  v_hash    text  := md5(p_dialect || v_catalog::text || v_hints::text);
begin
  insert into tenant_db_catalog (
    tenant_id, dialect, catalog, hints, catalog_hash,
    discovery_error, discovered_at, updated_at
  )
  values (
    p_tenant_id, p_dialect::operator_db_type, v_catalog, v_hints, v_hash,
    p_discovery_error,
    case when p_discovery_error is null then now() else null end,
    now()
  )
  on conflict (tenant_id)
  do update set
    dialect = excluded.dialect,
    catalog = excluded.catalog,
    hints = excluded.hints,
    catalog_hash = excluded.catalog_hash,
    discovery_error = excluded.discovery_error,
    discovered_at = case when excluded.discovery_error is null then now() else null end,
    updated_at = now();
end $$;
revoke all on function set_tenant_db_catalog(uuid, text, jsonb, jsonb, text) from public;

create table if not exists mapping_confirmed (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  catalog_hash text not null,
  confirmed_map jsonb not null,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, catalog_hash)
);

alter table mapping_confirmed enable row level security;
drop policy if exists mapping_confirmed_member_select on mapping_confirmed;
create policy mapping_confirmed_member_select on mapping_confirmed
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid()
              and tu.tenant_id = mapping_confirmed.tenant_id)
  );

create or replace function set_mapping_confirmed(
  p_tenant_id uuid,
  p_catalog_hash text,
  p_confirmed_map jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_current_hash text;
  v_catalog jsonb;
  v_disc_err text;
  v_key text;
  v_val jsonb;
  v_table text;
  v_fkey text;
  v_fval text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(p_tenant_id);

  if p_confirmed_map is null or jsonb_typeof(p_confirmed_map) <> 'object' then
    raise exception 'confirmed_map must be a json object' using errcode = '22023';
  end if;

  select catalog_hash, catalog, discovery_error
    into v_current_hash, v_catalog, v_disc_err
    from tenant_db_catalog
   where tenant_id = p_tenant_id;

  if v_current_hash is null then
    raise exception 'no discovered catalog for tenant %; connect + discover first', p_tenant_id
      using errcode = 'P0002';
  end if;
  if v_disc_err is not null then
    raise exception 'discovery incomplete for tenant %; cannot confirm mapping', p_tenant_id
      using errcode = '22023';
  end if;

  if p_catalog_hash is null or p_catalog_hash <> v_current_hash then
    raise exception 'stale catalog_hash (submitted %, current %); re-fetch the current mapping before confirming',
      p_catalog_hash, v_current_hash
      using errcode = '22023';
  end if;

  for v_key, v_val in select * from jsonb_each(p_confirmed_map)
  loop
    if jsonb_typeof(v_val) = 'object' and (v_val ? 'table') then
      v_table := v_val->>'table';

      if v_table is null or length(trim(v_table)) = 0 then
        raise exception 'mapping key % has empty table', v_key using errcode = '22023';
      end if;

      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_catalog->'tables', '[]'::jsonb)) t
         where t->>'name' = v_table
      ) then
        raise exception 'mapping key % references unknown table %', v_key, v_table
          using errcode = '22023';
      end if;

      for v_fkey, v_fval in select * from jsonb_each_text(v_val)
      loop
        if (v_fkey = 'field' or v_fkey ~ '_field$')
           and v_fval is not null and length(trim(v_fval)) > 0 then
          if not exists (
            select 1
              from jsonb_array_elements(coalesce(v_catalog->'tables', '[]'::jsonb)) t,
                   jsonb_array_elements(coalesce(t->'columns', '[]'::jsonb)) c
             where t->>'name' = v_table
               and c->>'name' = v_fval
          ) then
            raise exception 'mapping key %.% references unknown field %.%',
              v_key, v_fkey, v_table, v_fval
              using errcode = '22023';
          end if;
        end if;
      end loop;
    end if;
  end loop;

  insert into mapping_confirmed (tenant_id, catalog_hash, confirmed_map, confirmed_by)
  values (p_tenant_id, p_catalog_hash, p_confirmed_map, auth.uid())
  on conflict (tenant_id, catalog_hash)
  do update set
    confirmed_map = excluded.confirmed_map,
    confirmed_by  = excluded.confirmed_by,
    confirmed_at  = now(),
    updated_at    = now();
end $$;
revoke all on function set_mapping_confirmed(uuid, text, jsonb) from public;
grant execute on function set_mapping_confirmed(uuid, text, jsonb) to authenticated;

create table if not exists growth_diagnosis_provenance (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  run_id       uuid not null references agent_runs(id) on delete cascade,
  query_id     text not null,
  source       text,
  window_start timestamptz,
  window_end   timestamptz,
  numerator    numeric,
  denominator  numeric,
  row_count    bigint,
  truncated    boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (tenant_id, run_id, query_id)
);

create index if not exists growth_diagnosis_provenance_lookup
  on growth_diagnosis_provenance (tenant_id, run_id);

alter table growth_diagnosis_provenance enable row level security;
drop policy if exists growth_diagnosis_provenance_member_select on growth_diagnosis_provenance;
create policy growth_diagnosis_provenance_member_select on growth_diagnosis_provenance
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid()
              and tu.tenant_id = growth_diagnosis_provenance.tenant_id)
  );

create or replace function record_diagnosis_provenance(
  p_tenant_id uuid,
  p_run_id uuid,
  p_query_id text,
  p_source text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_numerator numeric,
  p_denominator numeric,
  p_row_count bigint,
  p_truncated boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_query_id is null or length(trim(p_query_id)) = 0 then
    raise exception 'query_id required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from agent_runs where id = p_run_id and tenant_id = p_tenant_id
  ) then
    raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id
      using errcode = '42501';
  end if;

  insert into growth_diagnosis_provenance (
    tenant_id, run_id, query_id, source, window_start, window_end,
    numerator, denominator, row_count, truncated
  )
  values (
    p_tenant_id, p_run_id, p_query_id, p_source, p_window_start, p_window_end,
    p_numerator, p_denominator, p_row_count, coalesce(p_truncated, false)
  )
  on conflict (tenant_id, run_id, query_id)
  do update set
    source       = excluded.source,
    window_start = excluded.window_start,
    window_end   = excluded.window_end,
    numerator    = excluded.numerator,
    denominator  = excluded.denominator,
    row_count    = excluded.row_count,
    truncated    = excluded.truncated;
end $$;
revoke all on function record_diagnosis_provenance(uuid, uuid, text, text, timestamptz, timestamptz, numeric, numeric, bigint, boolean) from public, anon, authenticated;
grant execute on function record_diagnosis_provenance(uuid, uuid, text, text, timestamptz, timestamptz, numeric, numeric, bigint, boolean) to service_role;

create or replace function get_diagnosis_provenance(
  p_run_id uuid,
  p_query_id text
) returns table (
  run_id       uuid,
  query_id     text,
  source       text,
  window_start timestamptz,
  window_end   timestamptz,
  numerator    numeric,
  denominator  numeric,
  row_count    bigint,
  truncated    boolean
)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_member(v_tenant);

  return query
    select p.run_id, p.query_id, p.source, p.window_start, p.window_end,
           p.numerator, p.denominator, p.row_count, p.truncated
      from growth_diagnosis_provenance p
     where p.tenant_id = v_tenant
       and p.run_id = p_run_id
       and p.query_id = p_query_id;
end $$;
revoke all on function get_diagnosis_provenance(uuid, text) from public;
grant execute on function get_diagnosis_provenance(uuid, text) to authenticated;
