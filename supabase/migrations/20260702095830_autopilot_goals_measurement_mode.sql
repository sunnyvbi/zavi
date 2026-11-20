
begin;

alter table autopilot_goals
  add column if not exists measurement_mode text not null default 'unmapped'
    check (measurement_mode in ('auto','manual_reported','unmapped'));

commit;
