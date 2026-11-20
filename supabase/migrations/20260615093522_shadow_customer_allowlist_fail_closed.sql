
update system_config
set blob = case
             when blob ? 'shadow_customer_tenant_ids' then blob
             else jsonb_set(blob, '{shadow_customer_tenant_ids}', '[]'::jsonb, true)
           end,
    updated_at = now()
where id = 1;

create or replace function shadow_tenant_allowed(p_tenant_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_allowed boolean;
begin
  if p_tenant_id is null then
    return false;
  end if;

  if p_tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'::uuid then
    return true;
  end if;

  select coalesce(
           (blob->'shadow_customer_tenant_ids') @> to_jsonb(p_tenant_id::text),
           false
         )
    into v_allowed
    from system_config where id = 1;

  return coalesce(v_allowed, false);
end $$;

revoke all on function shadow_tenant_allowed(uuid) from public, authenticated, anon;
grant execute on function shadow_tenant_allowed(uuid) to service_role;

drop policy if exists asr_member_select on agent_shadow_runs;
revoke select on agent_shadow_runs from authenticated, anon;

drop function if exists insert_shadow_run(
  uuid, text, text, text, text, boolean, text, jsonb, jsonb, jsonb, numeric,
  integer, jsonb, integer, text, text, text
);

create or replace function insert_shadow_run(
  p_source_agent_run_id  uuid,
  p_model                text,
  p_mode                 text,
  p_comparison_basis     text,
  p_status               text,
  p_parse_ok             boolean,
  p_output_text          text,
  p_parsed_output        jsonb,
  p_tool_calls           jsonb,
  p_usage                jsonb,
  p_cost_usd             numeric,
  p_latency_ms           integer,
  p_deterministic_checks jsonb,
  p_comparison_score     integer,
  p_comparison_notes     text,
  p_error                text,
  p_provider             text default 'openai'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_slug   text;
  v_id     uuid;
begin
  if p_provider not in ('openai', 'bedrock') then
    raise exception 'invalid shadow provider %, must be openai|bedrock', p_provider
      using errcode = '22023';
  end if;

  select tenant_id, agent_slug into v_tenant, v_slug
    from agent_runs where id = p_source_agent_run_id;
  if v_tenant is null then
    raise exception 'source agent_run % not found', p_source_agent_run_id
      using errcode = '22023';
  end if;

  if not shadow_tenant_allowed(v_tenant) then
    raise exception 'shadow runs not allowed for tenant % (not on the shadow allowlist)', v_tenant
      using errcode = '22023';
  end if;

  insert into agent_shadow_runs (
    source_agent_run_id, tenant_id, agent_slug, provider, model, mode,
    comparison_basis, status, parse_ok, output_text, parsed_output, tool_calls,
    usage, cost_usd, latency_ms, deterministic_checks, comparison_score,
    comparison_notes, error
  ) values (
    p_source_agent_run_id, v_tenant, v_slug, p_provider, p_model, p_mode,
    p_comparison_basis, p_status, p_parse_ok, p_output_text, p_parsed_output,
    coalesce(p_tool_calls, '[]'::jsonb), p_usage, coalesce(p_cost_usd, 0),
    p_latency_ms, p_deterministic_checks, p_comparison_score, p_comparison_notes,
    p_error
  )
  on conflict (source_agent_run_id, mode, provider, model) do nothing
  returning id into v_id;

  return v_id;
end $$;

revoke all on function insert_shadow_run(uuid, text, text, text, text, boolean, text, jsonb, jsonb, jsonb, numeric, integer, jsonb, integer, text, text, text) from public, authenticated, anon;
grant execute on function insert_shadow_run(uuid, text, text, text, text, boolean, text, jsonb, jsonb, jsonb, numeric, integer, jsonb, integer, text, text, text) to service_role;

create or replace function grade_shadow_run(
  p_shadow_run_id    uuid,
  p_comparison_score integer,
  p_comparison_notes text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_status text;
  v_rows   integer;
begin
  if p_comparison_score is null or p_comparison_score < 0 or p_comparison_score > 4 then
    raise exception 'comparison_score must be 0..4 (got %)', p_comparison_score
      using errcode = '22023';
  end if;

  select ar.tenant_id, asr.status into v_tenant, v_status
    from agent_shadow_runs asr
    join agent_runs ar on ar.id = asr.source_agent_run_id
   where asr.id = p_shadow_run_id;

  if v_tenant is null then
    raise exception 'shadow run % not found', p_shadow_run_id using errcode = '22023';
  end if;

  if not shadow_tenant_allowed(v_tenant) then
    raise exception 'shadow grading not allowed for tenant % (not on the shadow allowlist)', v_tenant
      using errcode = '22023';
  end if;

  if v_status not in ('success', 'parse_failed') then
    raise exception 'cannot grade shadow run with status % (need success|parse_failed)', v_status
      using errcode = '22023';
  end if;

  update agent_shadow_runs
     set comparison_score = p_comparison_score,
         comparison_notes = p_comparison_notes
   where id = p_shadow_run_id
     and comparison_score is null;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

revoke all on function grade_shadow_run(uuid, integer, text) from public, authenticated, anon;
grant execute on function grade_shadow_run(uuid, integer, text) to service_role;
