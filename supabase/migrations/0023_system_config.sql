
create table system_config (
  id smallint primary key check (id = 1),
  blob jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into system_config (id, blob) values (1, '{}'::jsonb)
  on conflict (id) do nothing;

