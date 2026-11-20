
alter table agent_runs
  add column if not exists auth_seat text;

comment on column agent_runs.auth_seat is
  'Stable hash-derived label of the Claude credential that served this run (seat_<hex> for a subscription seat, "api_key" for metered). NEVER the token itself. NULL for runs before 2026-09-07 or where no credential was resolved.';

create table if not exists agent_auth_seat_cooldown (
  seat          text primary key,
  cooling_until timestamptz not null,
  reason        text,
  updated_at    timestamptz not null default now()
);

comment on table agent_auth_seat_cooldown is
  'Fleet-shared "this subscription seat hit its usage cap" signal. Written fire-and-forget by any replica that sees a usage-limit; read into each replica''s in-process cache on a short timer. Platform credential state — NOT tenant data. Accessed via globalClient() (registered scope "global" in services/tenant-client.ts).';

alter table agent_auth_seat_cooldown enable row level security;

create index if not exists agent_auth_seat_cooldown_live_idx
  on agent_auth_seat_cooldown (cooling_until desc);
