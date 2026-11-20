
create table if not exists slack_source_message_lifecycle (
  tenant_id      uuid not null,
  team_id        text not null,
  channel_id     text not null,
  source_ts      text not null,
  tombstoned     boolean not null default false,
  latest_edit_ts text,
  superseded_by  uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, team_id, channel_id, source_ts)
);

alter table slack_source_message_lifecycle enable row level security;

drop policy if exists slack_source_message_lifecycle_select on slack_source_message_lifecycle;
create policy slack_source_message_lifecycle_select on slack_source_message_lifecycle
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = slack_source_message_lifecycle.tenant_id)
  );
