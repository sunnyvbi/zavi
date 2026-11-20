
alter table memory_signal
  add column if not exists step_idx int;

alter table memory_signal
  drop constraint if exists memory_signal_kind_chk;
alter table memory_signal
  add constraint memory_signal_kind_chk
  check (signal_kind in ('episode','gap','correction','outcome','operator_step'));

create index if not exists memory_signal_step_idx
  on memory_signal (agent_run_id, step_idx)
  where signal_kind = 'operator_step';

create or replace function memory_signal_operator_step_tenant_guard()
returns trigger
language plpgsql
as $$
declare
  expected_tenant uuid;
begin
  if new.signal_kind <> 'operator_step' or new.agent_run_id is null then
    return new;
  end if;

  select tenant_id into expected_tenant
    from agent_runs
   where id = new.agent_run_id;

  if expected_tenant is null then
    raise exception 'operator_step references unknown agent_run_id %', new.agent_run_id
      using errcode = 'check_violation';
  end if;

  if new.tenant_id <> expected_tenant then
    raise exception 'operator_step tenant_id % does not match agent_runs.tenant_id % for run %',
      new.tenant_id, expected_tenant, new.agent_run_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists memory_signal_operator_step_tenant_guard_trg on memory_signal;
create trigger memory_signal_operator_step_tenant_guard_trg
  before insert on memory_signal
  for each row
  execute function memory_signal_operator_step_tenant_guard();
