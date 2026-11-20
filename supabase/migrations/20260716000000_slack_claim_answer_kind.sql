alter table slack_triage_claims
  add column if not exists answer_kind text
  check (answer_kind is null or answer_kind in ('provisional', 'final'));

comment on column slack_triage_claims.answer_kind is
  'Two-phase delivery slot: provisional (triage inline reply, upgradeable) vs '
  'final (terminal deliverable). NULL = legacy/pending. See 20260716000000 migration.';
