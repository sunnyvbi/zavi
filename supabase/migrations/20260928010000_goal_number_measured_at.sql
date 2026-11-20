
begin;

alter table autopilot_goals add column if not exists current_value_at timestamptz;
alter table autopilot_goals add column if not exists current_value_source text
  check (current_value_source is null or char_length(current_value_source) <= 200);

create or replace function stamp_goal_current_value_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.current_value is null then
    new.current_value_at := null;
  elsif tg_op = 'INSERT' then
    new.current_value_at := coalesce(new.current_value_at, now());
  elsif new.current_value is distinct from old.current_value
        and new.current_value_at is not distinct from old.current_value_at then
    new.current_value_at := null;
    new.current_value_source := null;
  end if;
  return new;
end $$;

drop trigger if exists autopilot_goals_stamp_current_value_at on autopilot_goals;
create trigger autopilot_goals_stamp_current_value_at
  before insert or update of current_value on autopilot_goals
  for each row execute function stamp_goal_current_value_at();

do $$
begin
  raise notice '20260928010000: autopilot_goals.current_value_at / current_value_source + stamp trigger';
end $$;

commit;
