begin;

alter table seo_audit_snapshots
  add column if not exists performance_report jsonb
    check (performance_report is null or jsonb_typeof(performance_report) = 'object');

comment on column seo_audit_snapshots.performance_report is
  'Google web-vitals for the crawled pages. field = CrUX real-user p75 (measured); lab = Lighthouse synthetic (diagnostic only). Never merge the two into one score. Carries its own fetched_at and its own, longer TTL than the crawl.';

commit;
