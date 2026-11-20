
alter table connector_metadata add column if not exists bot_user_id text;

create or replace function set_slack_connection(
  p_tenant_id uuid,
  p_token text,
  p_team_id text,
  p_team_name text,
  p_scopes text[],
  p_bot_user_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_old_id uuid; v_new_id uuid;
begin
  select vault_secret_id into v_old_id from secrets
  where tenant_id = p_tenant_id and key = 'slack.bot_token';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'slack.bot_token';
  end if;

  v_new_id := vault.create_secret(p_token);

  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'slack.bot_token', v_new_id);

  insert into connector_metadata
    (tenant_id, slug, team_id, team_name, scopes, bot_user_id, connected_at)
  values
    (p_tenant_id, 'slack', p_team_id, p_team_name, p_scopes, p_bot_user_id, now())
  on conflict (tenant_id, slug)
  do update set team_id     = excluded.team_id,
                team_name   = excluded.team_name,
                scopes      = excluded.scopes,
                bot_user_id = excluded.bot_user_id,
                connected_at = excluded.connected_at;
end $$;
revoke all on function set_slack_connection(uuid, text, text, text, text[], text) from public;

create or replace function set_slack_connection(
  p_tenant_id uuid,
  p_token text,
  p_team_id text,
  p_team_name text,
  p_scopes text[]
) returns void
language plpgsql security definer set search_path = public, vault as $$
begin
  perform set_slack_connection(
    p_tenant_id, p_token, p_team_id, p_team_name, p_scopes, null::text
  );
end $$;
revoke all on function set_slack_connection(uuid, text, text, text, text[]) from public;

create table slack_triage_window (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  window_hour timestamptz not null,
  count       int not null default 0,
  primary key (tenant_id, window_hour)
);

create table slack_triage_claims (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  event_id   text not null,
  status     text not null check (status in ('processing', 'done')),
  claimed_at timestamptz not null default now(),
  replied_at timestamptz,
  primary key (tenant_id, event_id)
);

create or replace function slack_triage_consume(
  p_tenant_id uuid,
  p_event_id text,
  p_limit int
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_claimed_at timestamptz;
  v_hour timestamptz := date_trunc('hour', now());
  v_count int;
begin
  select status, claimed_at into v_status, v_claimed_at
  from slack_triage_claims
  where tenant_id = p_tenant_id and event_id = p_event_id
  for update;

  if not found then
    insert into slack_triage_claims (tenant_id, event_id, status)
    values (p_tenant_id, p_event_id, 'processing');
  elsif v_status = 'done' then
    return 'duplicate';
  elsif v_status = 'processing' and v_claimed_at > now() - interval '5 minutes' then
    return 'in_flight';
  else
    update slack_triage_claims set claimed_at = now()
    where tenant_id = p_tenant_id and event_id = p_event_id;
  end if;

  insert into slack_triage_window (tenant_id, window_hour, count)
  values (p_tenant_id, v_hour, 1)
  on conflict (tenant_id, window_hour)
  do update set count = slack_triage_window.count + 1
  returning count into v_count;

  if v_count > p_limit then
    return 'rate_limited';
  end if;
  return 'ok';
end $$;
revoke all on function slack_triage_consume(uuid, text, int) from public;
