create or replace function suppress_decision(
  p_decision_id uuid,
  p_source text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_class  text;
  v_body   jsonb;
  v_paths  text[];
  v_key    text;
begin
  if p_source is null or p_source not in ('reject', 'dismiss', 'expire', 'backfill') then
    raise exception 'invalid suppression source: %', p_source using errcode = '22023';
  end if;

  select d.tenant_id, d.decision_class, d.body
    into v_tenant, v_class, v_body
  from decisions d where d.id = p_decision_id;

  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '22023';
  end if;

  select dc.target_key_paths into v_paths
  from decision_classes dc where dc.slug = v_class;

  v_key := decision_suppression_key(v_body, v_paths);
  if v_key is null then
    return null;
  end if;

  insert into decision_suppressions (
    tenant_id, decision_class, suppression_key, decision_id, suppressed_by, source
  ) values (
    v_tenant, v_class, v_key, p_decision_id, auth.uid(), p_source
  )
  on conflict (tenant_id, decision_class, suppression_key) do update
    set decision_id   = excluded.decision_id,
        suppressed_by = coalesce(excluded.suppressed_by, decision_suppressions.suppressed_by),
        source        = excluded.source;

  return v_key;
end $$;

revoke all on function suppress_decision(uuid, text) from public;
grant execute on function suppress_decision(uuid, text) to service_role;
