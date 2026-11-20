
create or replace function stamp_agent_run_actor()
returns trigger language plpgsql as $$
begin
  new.actor_source := coalesce(new.actor_source, new.trigger);
  new.actor_user_id := coalesce(new.actor_user_id, new.enqueued_by);
  return new;
end $$;

drop trigger if exists agent_runs_stamp_actor on public.agent_runs;
create trigger agent_runs_stamp_actor
  before insert on public.agent_runs
  for each row execute function stamp_agent_run_actor();
