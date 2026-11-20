

create table slack_workspaces (
  tenant_id          uuid not null references tenants(id) on delete cascade,
  team_id            text not null,
  team_name          text not null default '',
  bot_user_id        text,
  scopes             text[] not null default '{}',
  scopes_version     int not null default 1,
  purpose            text not null default 'general',
  label              text not null default '',
  default_agent_slug text,
  is_primary         boolean not null default false,
  connected_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, team_id),
  unique (team_id),
  check (length(team_id) > 0)
);

create unique index slack_workspaces_one_primary
  on slack_workspaces (tenant_id) where is_primary;

alter table slack_workspaces enable row level security;

create policy slack_workspaces_member_select on slack_workspaces
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = slack_workspaces.tenant_id
    )
  );

alter table slack_channels        add column if not exists team_id text;
alter table slack_channel_members add column if not exists team_id text;

update slack_channels c
   set team_id = cm.team_id
  from connector_metadata cm
 where cm.tenant_id = c.tenant_id
   and cm.slug = 'slack'
   and cm.team_id is not null
   and c.team_id is null;

update slack_channel_members m
   set team_id = cm.team_id
  from connector_metadata cm
 where cm.tenant_id = m.tenant_id
   and cm.slug = 'slack'
   and cm.team_id is not null
   and m.team_id is null;

update slack_channels        set team_id = '' where team_id is null;
update slack_channel_members set team_id = '' where team_id is null;

alter table slack_channels        alter column team_id set not null;
alter table slack_channel_members alter column team_id set not null;

alter table slack_channels        drop constraint slack_channels_pkey;
alter table slack_channels        add  primary key (tenant_id, team_id, channel_id);

alter table slack_channel_members drop constraint slack_channel_members_pkey;
alter table slack_channel_members add  primary key (tenant_id, team_id, channel_id, slack_user_id);

alter table team_member_identities add column if not exists team_id text;

alter table team_member_identities
  drop constraint team_member_identities_tenant_id_provider_external_id_key;

create unique index team_member_identities_tenant_provider_team_external_uniq
  on team_member_identities
     (tenant_id, provider, coalesce(team_id, ''), external_id);

update team_member_identities i
   set team_id = cm.team_id
  from connector_metadata cm
 where cm.tenant_id = i.tenant_id
   and cm.slug = 'slack'
   and cm.team_id is not null
   and i.provider = 'slack'
   and i.team_id is null;

insert into slack_workspaces
  (tenant_id, team_id, team_name, bot_user_id, scopes, scopes_version,
   purpose, label, default_agent_slug, is_primary, connected_at)
select cm.tenant_id,
       cm.team_id,
       coalesce(cm.team_name, ''),
       cm.bot_user_id,
       coalesce(cm.scopes, '{}'::text[]),
       coalesce(cm.scopes_version, 1),
       'general',
       coalesce(cm.team_name, ''),
       null,
       true,
       coalesce(cm.connected_at, now())
  from connector_metadata cm
 where cm.slug = 'slack'
   and cm.team_id is not null
on conflict (tenant_id, team_id) do update
   set team_name      = excluded.team_name,
       bot_user_id    = excluded.bot_user_id,
       scopes         = excluded.scopes,
       scopes_version = excluded.scopes_version,
       updated_at     = now();

do $$
declare v_bad int;
begin
  select count(*) into v_bad from (
    select tenant_id from slack_workspaces where is_primary
    group by tenant_id having count(*) > 1
  ) q;
  if v_bad > 0 then
    raise exception 'slack_multi_workspace backfill produced % tenant(s) with >1 is_primary', v_bad;
  end if;
end $$;

create or replace function set_slack_connection(
  p_tenant_id uuid,
  p_token text,
  p_team_id text,
  p_team_name text,
  p_scopes text[],
  p_bot_user_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_id uuid;
  v_new_id uuid;
  v_key text := 'slack.bot_token:' || p_team_id;
  v_is_primary boolean;
begin
  select vault_secret_id into v_old_id from secrets
   where tenant_id = p_tenant_id and key = v_key;
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = v_key;
  end if;

  v_new_id := vault.create_secret(p_token);

  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, v_key, v_new_id);

  select not exists (
    select 1 from slack_workspaces
     where tenant_id = p_tenant_id and team_id <> p_team_id
  ) into v_is_primary;

  if v_is_primary then
    update slack_workspaces
       set is_primary = false, updated_at = now()
     where tenant_id = p_tenant_id and is_primary and team_id <> p_team_id;
  end if;

  insert into slack_workspaces
    (tenant_id, team_id, team_name, bot_user_id, scopes, scopes_version,
     purpose, label, default_agent_slug, is_primary, connected_at)
  values
    (p_tenant_id, p_team_id, p_team_name, p_bot_user_id, p_scopes, 1,
     'general', p_team_name, null, v_is_primary, now())
  on conflict (tenant_id, team_id) do update
     set team_name      = excluded.team_name,
         bot_user_id    = excluded.bot_user_id,
         scopes         = excluded.scopes,
         scopes_version = slack_workspaces.scopes_version + 1,
         is_primary     = excluded.is_primary,
         connected_at   = excluded.connected_at,
         updated_at     = now();

  if v_is_primary then
    insert into connector_metadata
      (tenant_id, slug, team_id, team_name, scopes, bot_user_id, connected_at)
    values
      (p_tenant_id, 'slack', p_team_id, p_team_name, p_scopes, p_bot_user_id, now())
    on conflict (tenant_id, slug)
    do update set team_id      = excluded.team_id,
                  team_name    = excluded.team_name,
                  scopes       = excluded.scopes,
                  bot_user_id  = excluded.bot_user_id,
                  connected_at = excluded.connected_at;
  end if;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, 'slack', 'internal'::mcp_transport, null, null, null)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;
revoke all on function set_slack_connection(uuid, text, text, text, text[], text) from public;

create or replace function set_slack_workspace_meta(
  p_tenant_id          uuid,
  p_team_id            text,
  p_purpose            text default null,
  p_label              text default null,
  p_default_agent_slug text default null,
  p_is_primary         boolean default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from slack_workspaces
     where tenant_id = p_tenant_id and team_id = p_team_id
  ) then
    raise exception 'slack workspace % not found for tenant %', p_team_id, p_tenant_id
      using errcode = '42704';
  end if;

  if p_is_primary is true then
    update slack_workspaces
       set is_primary = false, updated_at = now()
     where tenant_id = p_tenant_id and is_primary and team_id <> p_team_id;
  end if;

  update slack_workspaces
     set purpose            = coalesce(p_purpose, purpose),
         label              = coalesce(p_label, label),
         default_agent_slug = case
                                when p_default_agent_slug is null then default_agent_slug
                                else nullif(p_default_agent_slug, '')
                              end,
         is_primary         = coalesce(p_is_primary, is_primary),
         updated_at         = now()
   where tenant_id = p_tenant_id and team_id = p_team_id;
end $$;
revoke all on function set_slack_workspace_meta(uuid, text, text, text, text, boolean) from public;
grant execute on function set_slack_workspace_meta(uuid, text, text, text, text, boolean) to service_role;

create or replace function rotate_legacy_slack_keys(p_tenant_id uuid default null)
returns int
language plpgsql security definer set search_path = public, vault as $$
declare
  v_rotated int := 0;
  r record;
  v_team_id text;
begin
  for r in
    select s.tenant_id, s.vault_secret_id
      from secrets s
     where s.key = 'slack.bot_token'
       and (p_tenant_id is null or s.tenant_id = p_tenant_id)
  loop
    select team_id into v_team_id
      from slack_workspaces
     where tenant_id = r.tenant_id and is_primary
     limit 1;
    if v_team_id is null then
      select team_id into v_team_id
        from slack_workspaces
       where tenant_id = r.tenant_id
       order by connected_at asc
       limit 1;
    end if;
    if v_team_id is null then
      continue;
    end if;

    insert into secrets (tenant_id, key, vault_secret_id)
    values (r.tenant_id, 'slack.bot_token:' || v_team_id, r.vault_secret_id)
    on conflict (tenant_id, key) do nothing;

    v_rotated := v_rotated + 1;
  end loop;

  return v_rotated;
end $$;
revoke all on function rotate_legacy_slack_keys(uuid) from public;
grant execute on function rotate_legacy_slack_keys(uuid) to service_role;
