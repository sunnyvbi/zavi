begin;
set local lock_timeout = '5s';
create index if not exists decisions_ship_pr_files_open_idx
  on public.decisions (emitted_at)
  where decision_class = 'engineer.ship-pr' and body ? 'files' and not (body ? 'files_content_purged_at');
commit;
