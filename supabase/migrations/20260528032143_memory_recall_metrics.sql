
create table if not exists memory_recall_metrics (
  agent_slug text not null,
  run_date date not null,
  clean_grounded_rate numeric not null check (clean_grounded_rate between 0 and 1),
  sample_size int not null default 0,
  computed_at timestamptz not null default now(),
  primary key (agent_slug, run_date)
);

alter table memory_recall_metrics enable row level security;
