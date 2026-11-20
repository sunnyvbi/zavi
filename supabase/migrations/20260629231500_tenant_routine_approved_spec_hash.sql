
alter table public.tenant_routines
  add column if not exists approved_spec_hash text;

comment on column public.tenant_routines.approved_spec_hash is
  'Canonical sha256 (v1: prefix) of the routine_spec at staged->approved claim. '
  'Verified fail-closed by the routine runner; NULL = legacy row approved before '
  'the content-pin shipped (runner allows, logs). See services/routines/routine-spec-hash.ts.';
