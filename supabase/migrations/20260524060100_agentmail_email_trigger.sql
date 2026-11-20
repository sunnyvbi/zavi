
do $$
declare c_name text;
begin
  select conname into c_name
  from pg_constraint
  where conrelid = 'agent_runs'::regclass
    and pg_get_constraintdef(oid) ilike '%trigger%';
  if c_name is not null then
    execute format('alter table agent_runs drop constraint %I', c_name);
  end if;
  alter table agent_runs
    add constraint agent_runs_trigger_check
    check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email'));
end $$;

alter table memory_signal drop constraint if exists memory_signal_trigger_chk;
alter table memory_signal
  add constraint memory_signal_trigger_chk
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email'));
