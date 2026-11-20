
create table if not exists agent_auth_seat_usage (
  seat            text        not null,
  rate_limit_type text        not null,
  status          text        not null,
  utilization     numeric,
  resets_at       timestamptz,
  observed_at     timestamptz not null default now(),
  primary key (seat, rate_limit_type)
);

comment on table agent_auth_seat_usage is
  'Latest Claude Agent SDK rate_limit_event per subscription seat and window. Platform credential state, NOT tenant data. Accessed via globalClient() (scope "global" in services/tenant-client.ts).';

alter table agent_auth_seat_usage enable row level security;

create or replace function bench_seat_cooldown(p_seat text, p_until timestamptz, p_reason text)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into agent_auth_seat_cooldown (seat, cooling_until, reason, updated_at)
  values (p_seat, p_until, coalesce(p_reason, 'usage_limit'), now())
  on conflict (seat) do update
    set cooling_until = greatest(agent_auth_seat_cooldown.cooling_until, excluded.cooling_until),
        reason = case
          when excluded.cooling_until > agent_auth_seat_cooldown.cooling_until then excluded.reason
          else agent_auth_seat_cooldown.reason
        end,
        updated_at = now();
$$;

create or replace function record_seat_usage(
  p_seat text,
  p_rate_limit_type text,
  p_status text,
  p_utilization numeric,
  p_resets_at timestamptz,
  p_observed_at timestamptz
)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into agent_auth_seat_usage (seat, rate_limit_type, status, utilization, resets_at, observed_at)
  values (p_seat, p_rate_limit_type, p_status, p_utilization, p_resets_at, p_observed_at)
  on conflict (seat, rate_limit_type) do update
    set status = excluded.status,
        utilization = excluded.utilization,
        resets_at = excluded.resets_at,
        observed_at = excluded.observed_at
    where agent_auth_seat_usage.observed_at < excluded.observed_at;
$$;

revoke all on function bench_seat_cooldown(text, timestamptz, text) from public, anon, authenticated;
revoke all on function record_seat_usage(text, text, text, numeric, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function bench_seat_cooldown(text, timestamptz, text) to service_role;
grant execute on function record_seat_usage(text, text, text, numeric, timestamptz, timestamptz) to service_role;
