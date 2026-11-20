
begin;

create table if not exists geo_prompts (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants(id) on delete cascade,
  prompt_text       text        not null check (length(btrim(prompt_text)) between 8 and 500),
  source            text        not null check (source in ('zavi', 'custom')),
  status            text        not null check (status in ('suggested', 'active', 'archived')),
  rationale         text        check (length(rationale) <= 500),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  status_changed_at timestamptz not null default now()
);

create unique index if not exists geo_prompts_tenant_text_live_uq
  on geo_prompts (tenant_id, lower(btrim(prompt_text)))
  where status in ('suggested', 'active');

comment on table geo_prompts is
  'GEO tier 2: the unbranded buyer questions a prompt sweep asks each AI engine. Branded prompts are refused by the service.';

create table if not exists geo_prompt_sweeps (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants(id) on delete cascade,
  status              text        not null default 'running'
                                  check (status in ('running', 'complete', 'partial', 'failed')),
  requested_by        uuid,
  country             text        not null check (country ~ '^[A-Z]{2}$'),
  location_code       int         not null,
  language_code       text        not null check (length(language_code) between 2 and 8),
  brand               text        not null check (length(btrim(brand)) between 1 and 200),
  owned_domains       text[]      not null default '{}',
  rivals              jsonb       not null default '[]'::jsonb check (jsonb_typeof(rivals) = 'array'),
  rival_set_hash      text        not null check (length(rival_set_hash) between 1 and 64),
  engines             text[]      not null,
  repeats             int         not null check (repeats between 1 and 10),
  prompts             jsonb       not null check (jsonb_typeof(prompts) = 'array'),
  prompt_set_hash     text        not null check (length(prompt_set_hash) between 1 and 64),
  responses_planned   int         not null check (responses_planned > 0),
  responses_collected int         not null default 0 check (responses_collected >= 0),
  responses_failed    int         not null default 0 check (responses_failed >= 0),
  est_cost_usd        numeric(12, 4) not null default 0 check (est_cost_usd >= 0),
  cost_usd            numeric(12, 4) check (cost_usd is null or cost_usd >= 0),
  metrics             jsonb       check (metrics is null or jsonb_typeof(metrics) = 'object'),
  error_code          text        check (length(error_code) <= 200),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  constraint geo_prompt_sweeps_id_tenant_uq unique (id, tenant_id)
);

create unique index if not exists geo_prompt_sweeps_one_running_uq
  on geo_prompt_sweeps (tenant_id)
  where status = 'running';

create index if not exists geo_prompt_sweeps_tenant_started_idx
  on geo_prompt_sweeps (tenant_id, started_at desc);

comment on table geo_prompt_sweeps is
  'GEO tier 2: one on-demand prompt sweep. metrics holds SAMPLED rates, each with its n and a 95% interval. Never averaged with the tier-1 readiness heuristic.';

create table if not exists geo_prompt_responses (
  id               uuid        primary key default gen_random_uuid(),
  sweep_id         uuid        not null,
  tenant_id        uuid        not null references tenants(id) on delete cascade,
  prompt_id        uuid        not null,
  engine           text        not null
                               check (engine in ('chatgpt', 'claude', 'gemini', 'perplexity')),
  repeat_index     int         not null check (repeat_index >= 0),
  status           text        not null check (status in ('ok', 'error')),
  error_code       text        check (length(error_code) <= 200),
  data_source      text        check (length(data_source) <= 100),
  model            text        check (length(model) <= 200),
  answer_text      text        check (length(answer_text) <= 40000),
  citations        jsonb       not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  brand_mentioned  boolean     not null default false,
  owned_cited      boolean     not null default false,
  rivals_mentioned text[]      not null default '{}',
  fan_out_queries  text[]      not null default '{}',
  answer_position  text        check (answer_position in ('primary', 'list_item', 'in_body', 'sources_only', 'absent')),
  cost_usd         numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  collected_at     timestamptz not null default now(),
  constraint geo_prompt_responses_sweep_fk
    foreign key (sweep_id, tenant_id) references geo_prompt_sweeps (id, tenant_id) on delete cascade,
  constraint geo_prompt_responses_slot_uq unique (tenant_id, sweep_id, prompt_id, engine, repeat_index)
);

comment on table geo_prompt_responses is
  'GEO tier 2: one sampled AI answer (one engine, one prompt, one repeat, one day). Evidence for the rates on geo_prompt_sweeps.metrics, never a rate by itself.';

create table if not exists geo_crawler_ingest_tokens (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants(id) on delete cascade,
  token_hash       text        not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix     text        not null check (length(token_prefix) between 8 and 32),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  last_received_at timestamptz
);

create unique index if not exists geo_crawler_ingest_tokens_hash_uq
  on geo_crawler_ingest_tokens (token_hash);

create unique index if not exists geo_crawler_ingest_tokens_one_active_uq
  on geo_crawler_ingest_tokens (tenant_id)
  where revoked_at is null;

create table if not exists geo_crawler_hits_daily (
  tenant_id     uuid        not null references tenants(id) on delete cascade,
  day           date        not null,
  bot           text        not null check (length(bot) between 1 and 64),
  path          text        not null check (length(path) between 1 and 512),
  status        int         not null check (status between 0 and 599),
  hits          int         not null check (hits >= 0),
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  primary key (tenant_id, day, bot, path, status)
);

comment on table geo_crawler_hits_daily is
  'GEO tier 3: daily request counts per named AI crawler, page and status, from logs the customer pushes. Proves access, not citation. No IP, raw log line or human traffic is ever stored here.';

create table if not exists geo_robots_observations (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants(id) on delete cascade,
  bot         text        not null check (length(bot) between 1 and 64),
  state       text        not null check (state in ('allowed', 'blocked', 'partial')),
  directive   text        check (length(directive) <= 500),
  observed_at timestamptz not null default now()
);

create index if not exists geo_robots_observations_tenant_bot_idx
  on geo_robots_observations (tenant_id, bot, observed_at desc);

alter table geo_prompts               enable row level security;
alter table geo_prompt_sweeps         enable row level security;
alter table geo_prompt_responses      enable row level security;
alter table geo_crawler_ingest_tokens enable row level security;
alter table geo_crawler_hits_daily    enable row level security;
alter table geo_robots_observations   enable row level security;

revoke all on table geo_prompts               from public, anon, authenticated;
revoke all on table geo_prompt_sweeps         from public, anon, authenticated;
revoke all on table geo_prompt_responses      from public, anon, authenticated;
revoke all on table geo_crawler_ingest_tokens from public, anon, authenticated;
revoke all on table geo_crawler_hits_daily    from public, anon, authenticated;
revoke all on table geo_robots_observations   from public, anon, authenticated;

grant all on table geo_prompts               to service_role;
grant all on table geo_prompt_sweeps         to service_role;
grant all on table geo_prompt_responses      to service_role;
grant all on table geo_crawler_ingest_tokens to service_role;
grant all on table geo_crawler_hits_daily    to service_role;
grant all on table geo_robots_observations   to service_role;

create or replace function geo_open_prompt_sweep(
  p_tenant_id         uuid,
  p_requested_by      uuid,
  p_country           text,
  p_location_code     int,
  p_language_code     text,
  p_brand             text,
  p_owned_domains     text[],
  p_rivals            jsonb,
  p_rival_set_hash    text,
  p_engines           text[],
  p_repeats           int,
  p_prompts           jsonb,
  p_prompt_set_hash   text,
  p_est_cost_usd      numeric,
  p_tenant_cap_7d     int,
  p_fleet_cap_usd_24h numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_planned int;
  v_used    int;
  v_fleet   numeric;
  v_cap     int     := greatest(coalesce(p_tenant_cap_7d, 0), 0);
  v_fcap    numeric := greatest(coalesce(p_fleet_cap_usd_24h, 0), 0);
  v_est     numeric := greatest(coalesce(p_est_cost_usd, 0), 0);
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

revoke all on function geo_open_prompt_sweep(uuid, uuid, text, int, text, text, text[], jsonb, text, text[], int, jsonb, text, numeric, int, numeric)
  from public, anon, authenticated;
grant execute on function geo_open_prompt_sweep(uuid, uuid, text, int, text, text, text[], jsonb, text, text[], int, jsonb, text, numeric, int, numeric)
  to service_role;

create or replace function geo_resolve_prompt_sweep(p_sweep_id uuid)
returns table (tenant_id uuid, status text)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.tenant_id, s.status from geo_prompt_sweeps s where s.id = p_sweep_id;
$$;

revoke all on function geo_resolve_prompt_sweep(uuid) from public, anon, authenticated;
grant execute on function geo_resolve_prompt_sweep(uuid) to service_role;

create or replace function geo_resolve_crawler_ingest_token(p_token_hash text)
returns table (tenant_id uuid, token_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.tenant_id, t.id
    from geo_crawler_ingest_tokens t
   where t.token_hash = p_token_hash
     and t.revoked_at is null;
$$;

revoke all on function geo_resolve_crawler_ingest_token(text) from public, anon, authenticated;
grant execute on function geo_resolve_crawler_ingest_token(text) to service_role;

create or replace function geo_rotate_crawler_ingest_token(
  p_tenant_id    uuid,
  p_token_hash   text,
  p_token_prefix text,
  p_created_by   uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'geo_rotate_crawler_ingest_token: tenant required' using errcode = '22023';
  end if;
  update geo_crawler_ingest_tokens
     set revoked_at = now()
   where tenant_id = p_tenant_id and revoked_at is null;
  insert into geo_crawler_ingest_tokens (tenant_id, token_hash, token_prefix, created_by)
  values (p_tenant_id, p_token_hash, p_token_prefix, p_created_by)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function geo_rotate_crawler_ingest_token(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function geo_rotate_crawler_ingest_token(uuid, text, text, uuid) to service_role;

create or replace function geo_record_crawler_hits(
  p_tenant_id uuid,
  p_token_id  uuid,
  p_rows      jsonb
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if not exists (
    select 1 from geo_crawler_ingest_tokens
     where id = p_token_id and tenant_id = p_tenant_id and revoked_at is null
  ) then
    raise exception 'geo_record_crawler_hits: token not active for tenant' using errcode = '28000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'geo_record_crawler_hits: rows must be an array of at most 5000' using errcode = '22023';
  end if;

  insert into geo_crawler_hits_daily as h
    (tenant_id, day, bot, path, status, hits, first_seen_at, last_seen_at)
  select p_tenant_id,
         (r->>'day')::date,
         r->>'bot',
         r->>'path',
         (r->>'status')::int,
         (r->>'hits')::int,
         (r->>'first_seen_at')::timestamptz,
         (r->>'last_seen_at')::timestamptz
    from jsonb_array_elements(p_rows) as r
   where (r->>'day')::date between current_date - 90 and current_date + 1
  on conflict (tenant_id, day, bot, path, status) do update
     set hits          = h.hits + excluded.hits,
         first_seen_at = least(h.first_seen_at, excluded.first_seen_at),
         last_seen_at  = greatest(h.last_seen_at, excluded.last_seen_at);
  get diagnostics v_n = row_count;

  update geo_crawler_ingest_tokens set last_received_at = now() where id = p_token_id;
  return v_n;
end $$;

revoke all on function geo_record_crawler_hits(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function geo_record_crawler_hits(uuid, uuid, jsonb) to service_role;

commit;

do $$
begin
  raise notice '20260917160000: GEO tier-2 prompt sweeps + tier-3 crawler hits (service-role only)';
end $$;
