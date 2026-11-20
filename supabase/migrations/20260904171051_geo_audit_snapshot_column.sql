begin;

alter table seo_audit_snapshots
  add column if not exists geo_report jsonb
    check (geo_report is null or jsonb_typeof(geo_report) = 'object');

comment on column seo_audit_snapshots.geo_report is
  'AI-search readiness derived from the SAME crawl as report. Diagnostic only: never a citation count, share-of-voice or AI-traffic figure — no such API exists.';

commit;
