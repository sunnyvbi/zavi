
alter table public.custom_agent_triggers
  add column if not exists last_setup_block_emailed text;
