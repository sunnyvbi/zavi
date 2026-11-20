
alter table agent_runs
  add column if not exists reasoning_text text;

comment on column agent_runs.reasoning_text is
  'Optional denormalized reasoning summary, written at terminal-persist. '
  'thread_event remains canonical for event playback.';
