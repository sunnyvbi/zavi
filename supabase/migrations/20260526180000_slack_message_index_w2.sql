
create table slack_message_index (
  tenant_id          uuid        not null references tenants(id) on delete cascade,
  channel_id         text        not null,
  ts                 text        not null,
  author_user_id     text,
  text_redacted      text        not null,
  thread_ts          text,
  msg_subtype        text,
  conversation_type  text        not null
                       check (conversation_type in (
                         'channel_public',
                         'channel_private',
                         'dm',
                         'mpim'
                       )),
  is_private         boolean     not null default false,
  source_team_id     text        not null,
  source_user_ids    text[]      not null default '{}',
  created_at         timestamptz not null default now(),
  primary key (tenant_id, channel_id, ts)
);

create index slack_message_index_channel_ts_idx
  on slack_message_index (tenant_id, channel_id, ts desc);

create index slack_message_index_author_idx
  on slack_message_index (tenant_id, author_user_id);

create index slack_message_index_conv_ts_idx
  on slack_message_index (tenant_id, conversation_type, ts desc);

alter table slack_message_index enable row level security;

create table tenant_slack_index_state (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  disabled_at      timestamptz,
  purged_at        timestamptz,
  purge_row_count  int,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);

create index tenant_slack_index_state_disabled_idx
  on tenant_slack_index_state (tenant_id)
  where disabled_at is not null;

alter table tenant_slack_index_state enable row level security;

create policy tenant_slack_index_state_member_select on tenant_slack_index_state
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = tenant_slack_index_state.tenant_id
    )
  );
