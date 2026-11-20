
alter table memory_recall_golden
  add column if not exists labeling_regime text,
  add column if not exists labeled_at timestamptz,
  add column if not exists judge_agreement numeric;

comment on column memory_recall_golden.labeling_regime is
  'How this golden was labeled: llm_judge_<N>family_v<k> | hand | behavioral. NULL = legacy/unknown. See apps/backend/scripts/memory-judge-label.ts.';
comment on column memory_recall_golden.judge_agreement is
  'Cross-family judge agreement 0..1 at label time. 1.0 = unanimous; <1 = split (low-confidence). Read by P2/S2 judge-vs-behavioral calibration.';
