
alter table cgo_hypotheses
  add column if not exists segment text check (segment is null or char_length(segment) between 1 and 80);

alter table cgo_hypotheses drop constraint if exists cgo_hypotheses_problem_check;
alter table cgo_hypotheses add constraint cgo_hypotheses_problem_check
  check (problem in ('traffic', 'conversion', 'activation', 'retention', 'offer', 'tracking', 'channel', 'other', 'supply'));
