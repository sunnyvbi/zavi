
create or replace function _social_publish_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (blob->>'social_publish_enabled')::boolean from system_config where id = 1), false);
$$;

create table if not exists social_destinations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  channel         text not null,
  account_id      text not null,
  destination_id  text not null,
  display_name    text,
  role_verified   text,
  last_verified_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (tenant_id, channel, account_id, destination_id)
);
alter table social_destinations enable row level security;
drop policy if exists social_destinations_select_own on social_destinations;
create policy social_destinations_select_own on social_destinations
  for select to authenticated
  using (tenant_id in (select tenant_id from tenant_users where user_id = auth.uid()));

create table if not exists social_posts (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete cascade,
  decision_id              uuid,
  agent_run_id             uuid,
  channel                  text not null,
  pipedream_app_slug       text not null,
  pipedream_action_id      text not null,
  account_id               text not null,
  destination_id           uuid references social_destinations(id),
  configured_props         jsonb not null default '{}'::jsonb,
  approved_payload_snapshot jsonb,
  snapshot_hash            text,
  scheduled_at             timestamptz,
  status                   text not null default 'approved'
                            check (status in ('approved','scheduled','publishing','published','failed','cancelled')),
  external_post_id         text,
  external_url             text,
  last_error               text
                            check (last_error is null or last_error in
                              ('disconnected','unauthorized_destination','vendor_rejected','transient_exhausted','channel_disabled','snapshot_changed')),
  idempotency_key          text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (idempotency_key)
);
alter table social_posts enable row level security;
drop policy if exists social_posts_select_own on social_posts;
create policy social_posts_select_own on social_posts
  for select to authenticated
  using (tenant_id in (select tenant_id from tenant_users where user_id = auth.uid()));
create index if not exists social_posts_tenant_status_idx on social_posts (tenant_id, status);
create index if not exists social_posts_scheduled_idx on social_posts (scheduled_at) where status = 'scheduled';

create table if not exists social_publish_attempts (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references social_posts(id) on delete cascade,
  idempotency_key text not null,
  attempt_no      int  not null default 1,
  status          text not null default 'claimed'
                    check (status in ('claimed','succeeded','failed','unknown')),
  request_hash    text,
  response        jsonb,
  error           text,
  created_at      timestamptz not null default now()
);
alter table social_publish_attempts enable row level security;
drop policy if exists social_publish_attempts_select_own on social_publish_attempts;
create policy social_publish_attempts_select_own on social_publish_attempts
  for select to authenticated
  using (post_id in (select id from social_posts
                     where tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())));
create unique index if not exists spa_idempotency_claim_uq on social_publish_attempts (idempotency_key);
create index if not exists spa_post_idx on social_publish_attempts (post_id, attempt_no);

create or replace function _social_posts_immutable_guard()
returns trigger language plpgsql as $$
begin
  if old.snapshot_hash is not null then
    if new.approved_payload_snapshot is distinct from old.approved_payload_snapshot
       or new.snapshot_hash       is distinct from old.snapshot_hash
       or new.channel             is distinct from old.channel
       or new.pipedream_action_id is distinct from old.pipedream_action_id
       or new.account_id          is distinct from old.account_id
       or new.destination_id      is distinct from old.destination_id
       or new.configured_props    is distinct from old.configured_props
       or new.scheduled_at        is distinct from old.scheduled_at then
      raise exception 'social_posts: approved payload is immutable (edit/reschedule must create a new row)'
        using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists social_posts_immutable on social_posts;
create trigger social_posts_immutable
  before update on social_posts
  for each row execute function _social_posts_immutable_guard();

create or replace function social_post_create(
  p_tenant_id     uuid,
  p_decision_id   uuid,
  p_agent_run_id  uuid,
  p_channel       text,
  p_app_slug      text,
  p_action_id     text,
  p_account_id    text,
  p_destination_id uuid,
  p_configured_props jsonb,
  p_snapshot      jsonb,
  p_snapshot_hash text,
  p_scheduled_at  timestamptz,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_channel is null or p_action_id is null
     or p_account_id is null or p_idempotency_key is null or p_snapshot_hash is null then
    raise exception 'social_post_create: required field missing' using errcode = '22023';
  end if;
  insert into social_posts (
    tenant_id, decision_id, agent_run_id, channel, pipedream_app_slug,
    pipedream_action_id, account_id, destination_id, configured_props,
    approved_payload_snapshot, snapshot_hash, scheduled_at, idempotency_key,
    status
  ) values (
    p_tenant_id, p_decision_id, p_agent_run_id, p_channel, p_app_slug,
    p_action_id, p_account_id, p_destination_id, coalesce(p_configured_props, '{}'::jsonb),
    p_snapshot, p_snapshot_hash, p_scheduled_at, p_idempotency_key,
    case when p_scheduled_at is null then 'approved' else 'scheduled' end
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

create or replace function social_publish_claim(
  p_post_id uuid,
  p_idempotency_key text,
  p_request_hash text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from social_posts
   where id = p_post_id and status in ('approved','scheduled') for update;
  if not found then
    return false;
  end if;
  insert into social_publish_attempts (post_id, idempotency_key, request_hash, status)
  values (p_post_id, p_idempotency_key, p_request_hash, 'claimed');
  update social_posts set status = 'publishing', updated_at = now()
   where id = p_post_id;
  return true;
exception when unique_violation then
  return false;
end $$;

create or replace function social_publish_finalize(
  p_post_id text,
  p_ok boolean,
  p_external_post_id text,
  p_external_url text,
  p_error text,
  p_response jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare v_uuid uuid := p_post_id::uuid;
begin
  update social_publish_attempts
     set status = case when p_ok then 'succeeded' else 'failed' end,
         response = p_response, error = p_error
   where post_id = v_uuid;
  update social_posts
     set status = case when p_ok then 'published' else 'failed' end,
         external_post_id = coalesce(p_external_post_id, external_post_id),
         external_url = coalesce(p_external_url, external_url),
         last_error = case when p_ok then null else p_error end,
         updated_at = now()
   where id = v_uuid;
end $$;

update system_config
   set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{social_publish_enabled}', 'false'::jsonb, true)
 where id = 1
   and not (blob ? 'social_publish_enabled');

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto) values
  ('social.publish.v2',
   'Channel-generic external social publish via Pipedream. Body: {channel, payload:{text}, scheduled_at}. Approval-gated, customer-facing — never bulk-approvable, never auto.',
   'approval',
   'social.publish.v2',
   true)
on conflict (slug) do update set never_auto = true, dispatch_handler = excluded.dispatch_handler;

revoke all on function social_post_create(uuid, uuid, uuid, text, text, text, text, uuid, jsonb, jsonb, text, timestamptz, text) from public;
grant execute on function social_post_create(uuid, uuid, uuid, text, text, text, text, uuid, jsonb, jsonb, text, timestamptz, text) to service_role;
revoke all on function social_publish_claim(uuid, text, text) from public;
grant execute on function social_publish_claim(uuid, text, text) to service_role;
revoke all on function social_publish_finalize(text, boolean, text, text, text, jsonb) from public;
grant execute on function social_publish_finalize(text, boolean, text, text, text, jsonb) to service_role;
revoke all on function _social_publish_enabled() from public;
grant execute on function _social_publish_enabled() to service_role;
