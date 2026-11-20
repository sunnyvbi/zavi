create index if not exists decisions_proposed_emitted_at_idx
  on decisions (emitted_at)
  where status = 'proposed';
