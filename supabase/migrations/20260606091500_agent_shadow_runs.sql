
create table if not exists agent_shadow_runs (
  id                   uuid primary key default gen_random_uuid(),
  source_agent_run_id  uuid not null references agent_runs(id) on delete cascade,
  tenant_id            uuid not null references tenants(id) on delete cascade,
  agent_slug           text not null,
  provider             text not null default 'openai' check (provider in ('openai')),
  model                text not null,
  mode                 text not null check (mode in ('offline_replay', 'live_shadow')),
  comparison_basis     text,
  status               text not null check (status in ('success', 'parse_failed', 'dispatch_error', 'skipped')),
  parse_ok             boolean,
  output_text          text,
  parsed_output        jsonb,
  tool_calls           jsonb not null default '[]'::jsonb,
  usage                jsonb,
  cost_usd             numeric not null default 0,
  latency_ms           integer,
  deterministic_checks jsonb,
  comparison_score     integer check (comparison_score between 0 and 4),
  comparison_notes     text,
  error                text,
  created_at           timestamptz not null default now(),
  unique (source_agent_run_id, mode, provider, model)
);

create index if not exists agent_shadow_runs_tenant_created_idx
  on agent_shadow_runs (tenant_id, created_at desc);
create index if not exists agent_shadow_runs_source_idx
  on agent_shadow_runs (source_agent_run_id);

alter table agent_shadow_runs enable row level security;

drop policy if exists asr_member_select on agent_shadow_runs;
create policy asr_member_select on agent_shadow_runs
  for select to authenticated using (
    exists (
      select 1 from tenant_users
      where tenant_users.tenant_id = agent_shadow_runs.tenant_id
        and tenant_users.user_id = auth.uid()
    )
  );

revoke insert, update, delete on agent_shadow_runs from authenticated, anon;
grant select on agent_shadow_runs to authenticated;
grant all on agent_shadow_runs to service_role;

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
  p_error                text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_slug   text;
  v_id     uuid;
begin
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
    p_source_agent_run_id, v_tenant, v_slug, 'openai', p_model, p_mode,
    p_comparison_basis, p_status, p_parse_ok, p_output_text, p_parsed_output,
    coalesce(p_tool_calls, '[]'::jsonb), p_usage, coalesce(p_cost_usd, 0),
    p_latency_ms, p_deterministic_checks, p_comparison_score, p_comparison_notes,
    p_error
  )
  on conflict (source_agent_run_id, mode, provider, model) do nothing
  returning id into v_id;

  return v_id;
end $$;

revoke all on function insert_shadow_run(uuid, text, text, text, text, boolean, text, jsonb, jsonb, jsonb, numeric, integer, jsonb, integer, text, text) from public, authenticated, anon;
grant execute on function insert_shadow_run(uuid, text, text, text, text, boolean, text, jsonb, jsonb, jsonb, numeric, integer, jsonb, integer, text, text) to service_role;

create table if not exists shadow_daily_spend (
  day        date primary key,
  spent_usd  numeric not null default 0
);
alter table shadow_daily_spend enable row level security;
revoke all on shadow_daily_spend from authenticated, anon;
grant all on shadow_daily_spend to service_role;

create or replace function consume_shadow_budget_or_reject(p_estimated_usd numeric)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_disabled boolean;
  v_cap      numeric;
  v_spent    numeric;
begin
  select coalesce((blob->>'shadow_disabled')::boolean, false),
         coalesce(nullif(blob->>'shadow_daily_budget_usd','')::numeric, 20)
    into v_disabled, v_cap
    from system_config where id = 1;

  if not found then return 'disabled'; end if;
  if coalesce(v_disabled, true) then return 'disabled'; end if;

  insert into shadow_daily_spend (day, spent_usd) values (current_date, 0)
    on conflict (day) do nothing;
  select spent_usd into v_spent from shadow_daily_spend
    where day = current_date for update;

  if coalesce(v_spent, 0) + coalesce(p_estimated_usd, 0) > coalesce(v_cap, 0) then
    return 'over_cap';
  end if;

  update shadow_daily_spend
    set spent_usd = spent_usd + coalesce(p_estimated_usd, 0)
    where day = current_date;
  return 'charged';
end $$;

revoke all on function consume_shadow_budget_or_reject(numeric) from public, authenticated, anon;
grant execute on function consume_shadow_budget_or_reject(numeric) to service_role;

update system_config
set blob = jsonb_set(
             jsonb_set(blob, '{shadow_disabled}', 'false'::jsonb, true),
             '{shadow_daily_budget_usd}', '20'::jsonb, true
           ),
    updated_at = now()
where id = 1;
