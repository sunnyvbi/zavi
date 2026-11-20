begin;

create table if not exists growth_intake_research (
  tenant_id   uuid        not null references tenants(id) on delete cascade,
  day         date        not null,
  status      text        not null check (status in ('pending', 'ready', 'thin', 'failed')),
  reason      text        check (length(reason) <= 200),
  payload     jsonb       check (payload is null or jsonb_typeof(payload) = 'object'),
  est_cost_usd numeric(10,4),
  fetched_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, day),
  constraint growth_intake_research_ready_has_payload
    check (status <> 'ready' or payload is not null)
);

alter table growth_intake_research enable row level security;
revoke all on table growth_intake_research from public, anon, authenticated;
grant all on table growth_intake_research to service_role;

create or replace function claim_growth_intake_research(
  p_tenant_id uuid,
  p_day date,
  p_stale_pending_seconds int default 600
) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_claimed boolean := false;
begin
  insert into growth_intake_research (tenant_id, day, status)
  values (p_tenant_id, p_day, 'pending')
  on conflict (tenant_id, day) do nothing;

  if found then
    return true;
  end if;

  update growth_intake_research
     set status = 'pending', updated_at = now(), fetched_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and status = 'pending'
     and updated_at < now() - make_interval(secs => p_stale_pending_seconds)
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function claim_growth_intake_research(uuid, date, int) from public, anon, authenticated;
grant execute on function claim_growth_intake_research(uuid, date, int) to service_role;

create table if not exists enrichment_rate_limit (
  key           text        primary key check (length(key) <= 200),
  window_start  timestamptz not null default now(),
  count         int         not null default 0
);

alter table enrichment_rate_limit enable row level security;
revoke all on table enrichment_rate_limit from public, anon, authenticated;
grant all on table enrichment_rate_limit to service_role;

create or replace function tick_enrichment_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_count int;
begin
  insert into enrichment_rate_limit (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case
          when enrichment_rate_limit.window_start
               < now() - make_interval(secs => p_window_seconds)
          then now()
          else enrichment_rate_limit.window_start
        end,
        count = case
          when enrichment_rate_limit.window_start
               < now() - make_interval(secs => p_window_seconds)
          then 1
          else enrichment_rate_limit.count + 1
        end
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function tick_enrichment_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function tick_enrichment_rate_limit(text, int, int) to service_role;

commit;
