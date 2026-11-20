
begin;

alter table public.decisions
  add column if not exists slack_push_suppressed_at timestamptz;

comment on column public.decisions.slack_push_suppressed_at is
  'Set when Slack delivery was skipped because the tenant has slack_approval_push_enabled OFF. Distinct from slack_approval_posted_at (posted, or suppressed by origin) so approval-strand-probe can exclude opt-outs from the stranded count and the notify cron can exclude them from its scan. The decision remains pending + actionable in the web app.';

create index if not exists decisions_pending_slack_push_idx
  on public.decisions (tenant_id)
  where status = 'proposed'
    and autonomy_at_emit = 'approval'
    and slack_approval_posted_at is null
    and slack_push_suppressed_at is null;

commit;

do $$
begin
  raise notice '20260907190000: decisions.slack_push_suppressed_at + pending-push partial index';
end $$;
