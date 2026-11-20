
alter table agent_shadow_runs
  drop constraint if exists agent_shadow_runs_provider_check;
alter table agent_shadow_runs
  add constraint agent_shadow_runs_provider_check
  check (provider in ('openai', 'bedrock'));

drop function if exists insert_shadow_run(
  uuid, text, text, text, text, boolean, text, jsonb, jsonb, jsonb, numeric,
  integer, jsonb, integer, text, text
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

  if v_tenant <> '73db45ff-457e-4541-bc8f-bdb625390204'::uuid then
    raise exception 'shadow runs are restricted to the dogfood tenant in P0 (got %)', v_tenant
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
