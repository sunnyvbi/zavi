
begin;

create table if not exists autopilot_fleet_kill (
  id      int primary key default 1 check (id = 1),
  halted  boolean not null default false,
  reason  text,
  set_by  uuid references auth.users(id),
  set_at  timestamptz not null default now()
);

insert into autopilot_fleet_kill (id, halted) values (1, false)
  on conflict (id) do nothing;

alter table autopilot_fleet_kill enable row level security;
drop policy if exists autopilot_fleet_kill_select on autopilot_fleet_kill;
create policy autopilot_fleet_kill_select on autopilot_fleet_kill
  for select to authenticated using (true);

create or replace function is_fleet_halted()
returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select halted from autopilot_fleet_kill where id = 1), true);
$$;

revoke all on function is_fleet_halted() from public;
grant execute on function is_fleet_halted() to authenticated, service_role;

create or replace function set_fleet_kill(
  p_halted boolean,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update autopilot_fleet_kill
     set halted = coalesce(p_halted, true),
         reason = p_reason,
         set_at = now()
   where id = 1;
end $$;

revoke all on function set_fleet_kill(boolean, text) from public;
grant execute on function set_fleet_kill(boolean, text) to service_role;

commit;
