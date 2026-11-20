
alter table dream_candidates
  add column eval_delta jsonb,
  add column eval_status text check (
    eval_status in ('improved', 'regressed', 'neutral', 'no_goldens', 'unmeasured', 'error')
    or eval_status is null
  );
