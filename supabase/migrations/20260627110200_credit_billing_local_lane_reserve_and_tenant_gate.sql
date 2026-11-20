
create or replace function _credits_enforced(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    coalesce((select (blob->>'credits_enforced')::boolean from system_config where id = 1), false)
    or exists (
      select 1
      from system_config sc,
           lateral jsonb_array_elements_text(
             case when jsonb_typeof(sc.blob->'credits_enforced_allowlist') = 'array'
                  then sc.blob->'credits_enforced_allowlist'
                  else '[]'::jsonb end
           ) a
      where sc.id = 1 and a = p_tenant_id::text
    );
$$;

update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{credits_enforced_allowlist}', '[]'::jsonb)
where id = 1 and not (blob ? 'credits_enforced_allowlist');

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if NEW.status in ('queued', 'running') then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug));
  end if;
  return null;
end $$;

create or replace function _trg_finalize_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if OLD.status in ('queued','running')
     and NEW.status in ('success','parse_failed','error','failed','cancelled','dispatch_error') then
    perform finalize_run_credits(NEW.id, NEW.cost_usd, NEW.status);
  end if;
  return null;
end $$;

do $$
begin
  raise notice '20260627110200: local-lane reserve (running INSERT) + tenant-scoped _credits_enforced(tenant) gate wired; flag OFF + allowlist empty (inert)';
end $$;
