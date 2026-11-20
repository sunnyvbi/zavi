
create table if not exists runtime_memory_samples (
  id uuid primary key default gen_random_uuid(),
  sampled_at timestamptz not null default now(),
  container_role text not null default 'unknown',
  cgroup_current_mb integer,
  cgroup_peak_mb integer,
  cgroup_max_mb integer,
  node_rss_mb integer,
  claude_proc_count integer not null default 0,
  claude_rss_max_mb integer,
  claude_rss_sum_mb integer
);

create index if not exists runtime_memory_samples_sampled_at_idx
  on runtime_memory_samples (sampled_at desc);

alter table runtime_memory_samples enable row level security;

