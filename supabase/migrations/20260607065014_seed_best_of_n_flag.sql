
update system_config
set blob = jsonb_set(
      coalesce(blob, '{}'::jsonb),
      '{best_of_n}',
      '{"enabled": false, "n": 3, "nightly_max_candidates": 0, "concurrency": 0, "kill": false}'::jsonb,
      true
    ),
    updated_at = now()
where id = 1;

create table if not exists best_of_n_candidate_counter (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  day        date not null,
  candidates integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

alter table best_of_n_candidate_counter enable row level security;

