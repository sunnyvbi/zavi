
set search_path = public;

create index if not exists agent_runs_status_started_at
  on agent_runs (status, started_at)
  where status in ('queued', 'running');

comment on index agent_runs_status_started_at is
  'Backs queued-stuck-scan Path 2 hard-cap + last_progress_at-null fallback predicates (workers/functions/stuck-run-query.ts). Symmetric to agent_runs_status_last_progress (migration 0066). Partial on queued/running — the only rows the watchdog scans. See migration 20260524090559.';
