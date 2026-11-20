
set lock_timeout = '5s';

alter table agent_threads
  add column if not exists channel_slug text,
  add column if not exists channel_action_id uuid;

alter table agent_threads
  drop constraint if exists agent_threads_channel_action_fk;

alter table agent_threads
  add constraint agent_threads_channel_action_fk
  foreign key (tenant_id, channel_action_id)
  references channel_actions (tenant_id, id)
  on delete set null (channel_action_id);
