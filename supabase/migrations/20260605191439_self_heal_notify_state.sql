
alter table regression_signatures
  add column if not exists self_heal_notified_at    timestamptz,
  add column if not exists self_heal_cooldown_until  timestamptz;

create or replace function eligible_self_heal_signatures(
  p_min_runs     int,
  p_min_tenants  int,
  p_window_hours int
)
returns table (
  signature    text,
  code_class   text,
  agent_slug   text,
  run_count    bigint,
  tenant_count bigint
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select s.signature, s.code_class, s.agent_slug,
         count(distinct o.run_id)    as run_count,
         count(distinct o.tenant_id) as tenant_count
  from public.regression_signatures s
  join public.regression_signature_occurrences o on o.signature = s.signature
  where o.seen_at >= pg_catalog.now() - pg_catalog.make_interval(hours => p_window_hours)
    and (s.self_heal_cooldown_until is null or s.self_heal_cooldown_until < pg_catalog.now())
  group by s.signature, s.code_class, s.agent_slug
  having count(distinct o.run_id)    >= p_min_runs
     and count(distinct o.tenant_id) >= p_min_tenants;
$$;

create or replace function claim_self_heal_notify(
  p_signature      text,
  p_cooldown_hours int
)
returns table (signature text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return query
  update public.regression_signatures s
     set self_heal_notified_at    = pg_catalog.now(),
         self_heal_cooldown_until = pg_catalog.now() + pg_catalog.make_interval(hours => p_cooldown_hours),
         updated_at = pg_catalog.now()
   where s.signature = p_signature
     and (s.self_heal_cooldown_until is null or s.self_heal_cooldown_until < pg_catalog.now())
  returning s.signature;
end;
$$;

revoke all on function eligible_self_heal_signatures(int, int, int) from public, anon, authenticated;
revoke all on function claim_self_heal_notify(text, int) from public, anon, authenticated;
grant execute on function eligible_self_heal_signatures(int, int, int) to service_role;
grant execute on function claim_self_heal_notify(text, int) to service_role;
