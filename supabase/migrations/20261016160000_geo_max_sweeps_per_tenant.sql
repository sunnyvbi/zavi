
drop function if exists geo_open_prompt_sweep(
  uuid, uuid, text, int, text, text, text[], jsonb, text, text[], int, jsonb, text, numeric, int, numeric);

create or replace function geo_open_prompt_sweep(
  p_tenant_id              uuid,
  p_requested_by           uuid,
  p_country                text,
  p_location_code          int,
  p_language_code          text,
  p_brand                  text,
  p_owned_domains          text[],
  p_rivals                 jsonb,
  p_rival_set_hash         text,
  p_engines                text[],
  p_repeats                int,
  p_prompts                jsonb,
  p_prompt_set_hash        text,
  p_est_cost_usd           numeric,
  p_tenant_cap_7d          int,
  p_fleet_cap_usd_24h      numeric,
  p_max_sweeps_per_tenant  int default 3
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_planned int;
  v_used    int;
  v_fleet   numeric;
  v_cap     int     := greatest(coalesce(p_tenant_cap_7d, 0), 0);
  v_fcap    numeric := greatest(coalesce(p_fleet_cap_usd_24h, 0), 0);
  v_est     numeric := greatest(coalesce(p_est_cost_usd, 0), 0);
  v_lim     int     := greatest(coalesce(p_max_sweeps_per_tenant, 0), 0);
  v_done    int;
  v_id      uuid;
begin
  if p_tenant_id is null then
    raise exception 'geo_open_prompt_sweep: tenant required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('geo_open_prompt_sweep', 0));

  update geo_prompt_sweeps
     set status = 'failed', error_code = 'stale_running', finished_at = now()
   where tenant_id = p_tenant_id
     and status = 'running'
     and started_at < now() - interval '2 hours';

  if exists (select 1 from geo_prompt_sweeps where tenant_id = p_tenant_id and status = 'running') then
    return jsonb_build_object('ok', false, 'reason', 'already_running');
  end if;

  select count(*) into v_done
    from geo_prompt_sweeps
   where tenant_id = p_tenant_id
     and status in ('complete', 'partial');
  if v_done >= v_lim then
    return jsonb_build_object(
      'ok', false, 'reason', 'tenant_limit_reached',
      'runs_used', v_done, 'runs_limit', v_lim);
  end if;

  v_planned := coalesce(jsonb_array_length(p_prompts), 0)
             * coalesce(array_length(p_engines, 1), 0)
             * greatest(coalesce(p_repeats, 0), 0);
  if v_planned <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_run');
  end if;

  select coalesce(sum(responses_planned), 0) into v_used
    from geo_prompt_sweeps
   where tenant_id = p_tenant_id
     and started_at > now() - interval '7 days';

  if v_used + v_planned > v_cap then
    return jsonb_build_object(
      'ok', false, 'reason', 'tenant_cap_reached',
      'used_7d', v_used, 'cap_7d', v_cap, 'planned', v_planned);
  end if;

  select coalesce(sum(coalesce(cost_usd, est_cost_usd)), 0) into v_fleet
    from geo_prompt_sweeps
   where started_at > now() - interval '24 hours';

  if v_fleet + v_est > v_fcap then
    return jsonb_build_object('ok', false, 'reason', 'fleet_cap_reached');
  end if;

  insert into geo_prompt_sweeps (
    tenant_id, requested_by, country, location_code, language_code,
    brand, owned_domains, rivals, rival_set_hash,
    engines, repeats, prompts, prompt_set_hash, responses_planned, est_cost_usd
  ) values (
    p_tenant_id, p_requested_by, p_country, p_location_code, p_language_code,
    p_brand, coalesce(p_owned_domains, '{}'), coalesce(p_rivals, '[]'::jsonb), p_rival_set_hash,
    p_engines, p_repeats, p_prompts, p_prompt_set_hash, v_planned, v_est
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'sweep_id', v_id, 'planned', v_planned,
    'used_7d', v_used, 'cap_7d', v_cap);
end $$;

revoke all on function geo_open_prompt_sweep(uuid, uuid, text, int, text, text, text[], jsonb, text, text[], int, jsonb, text, numeric, int, numeric, int)
  from public, anon, authenticated;
grant execute on function geo_open_prompt_sweep(uuid, uuid, text, int, text, text, text[], jsonb, text, text[], int, jsonb, text, numeric, int, numeric, int)
  to service_role;
