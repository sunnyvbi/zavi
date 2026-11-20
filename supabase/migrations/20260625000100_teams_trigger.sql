alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams'));

alter table memory_signal drop constraint if exists memory_signal_trigger_chk;
alter table memory_signal
  add constraint memory_signal_trigger_chk
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams'));
