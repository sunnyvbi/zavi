

create table slack_channels (
  tenant_id            uuid not null references tenants(id) on delete cascade,
  channel_id           text not null,
  name                 text not null,
  purpose              text not null default '',
  topic                text not null default '',
  is_private           boolean not null default false,
  member_count         int not null default 0,
  sensitivity          text not null default 'unreviewed'
                         check (sensitivity in (
                           'unreviewed',
                           'public',
                           'eng',
                           'cx',
                           'exec_private'
                         )),
  summary_md           text,
  last_summarized_at   timestamptz,
  allow_proactive      boolean not null default false,
  joined_at            timestamptz,
  joined_by_run_id     uuid references agent_runs(id) on delete set null,
  join_policy_status   text,
  operator_selected_at timestamptz,
  operator_selected_by uuid references auth.users(id) on delete set null,
  skip_reason          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, channel_id)
);

create index slack_channels_summarize_idx
  on slack_channels (tenant_id, last_summarized_at);

create index slack_channels_allow_proactive_idx
  on slack_channels (tenant_id, allow_proactive)
  where allow_proactive;

alter table slack_channels enable row level security;

create policy slack_channels_member_select on slack_channels
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = slack_channels.tenant_id
    )
  );

create table slack_channel_members (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  channel_id     text not null,
  slack_user_id  text not null,
  refreshed_at   timestamptz not null default now(),
  primary key (tenant_id, channel_id, slack_user_id)
);

create index slack_channel_members_user_idx
  on slack_channel_members (tenant_id, slack_user_id);

alter table slack_channel_members enable row level security;

create policy slack_channel_members_member_select on slack_channel_members
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = slack_channel_members.tenant_id
    )
  );

alter table connector_metadata
  add column if not exists scopes_version int not null default 1;

create or replace function set_connector_scopes_version(
  p_tenant_id uuid,
  p_slug      text,
  p_version   int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update connector_metadata
     set scopes_version = p_version
   where tenant_id = p_tenant_id
     and slug = p_slug;
end $$;

revoke all on function set_connector_scopes_version(uuid, text, int) from public;
grant execute on function set_connector_scopes_version(uuid, text, int) to service_role;
