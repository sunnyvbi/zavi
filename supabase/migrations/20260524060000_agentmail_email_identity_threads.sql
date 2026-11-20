
create table tenant_inbox_domain (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  domain      text not null,
  status      text not null check (status in ('active','retired')) default 'active',
  created_at  timestamptz not null default now(),
  retired_at  timestamptz,
  unique (domain)
);
create index tenant_inbox_domain_tenant_idx on tenant_inbox_domain (tenant_id) where status = 'active';

create table tenant_agent_email_identity (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  agent_slug        text not null,
  domain_id         uuid not null references tenant_inbox_domain(id) on delete cascade,
  local_part        text not null,
  reply_to_address  text not null,
  from_address      text,
  from_name         text,
  status            text not null check (status in ('active','retired')) default 'active',
  created_at        timestamptz not null default now(),
  retired_at        timestamptz,
  unique (domain_id, local_part)
);
create index tenant_agent_email_identity_tenant_idx on tenant_agent_email_identity (tenant_id) where status = 'active';

create table email_threads (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  owner_agent_slug  text not null,
  owner_identity_id uuid references tenant_agent_email_identity(id) on delete set null,
  root_message_id   text,
  subject_normalized text,
  status            text not null check (status in ('open','closed')) default 'open',
  last_message_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (tenant_id, root_message_id)
);
create index email_threads_inbox_idx on email_threads (tenant_id, last_message_at desc);

create table email_messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  thread_id           uuid not null references email_threads(id) on delete cascade,
  direction           text not null check (direction in ('in','out')),
  provider_message_id text,
  rfc_message_id      text,
  in_reply_to         text,
  references_chain    text[] default array[]::text[],
  envelope_to         text,
  from_address        text,
  to_addresses        text[] default array[]::text[],
  cc_addresses        text[] default array[]::text[],
  subject             text,
  body_text           text,
  body_html_sanitized text,
  raw_mime_ref        text,
  spam_verdict        text check (spam_verdict in ('pass','spam','virus','unknown')),
  auto_submitted      boolean not null default false,
  headers             jsonb not null default '{}'::jsonb,
  dedup_key           text not null,
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (tenant_id, dedup_key)
);
create index email_messages_thread_idx on email_messages (thread_id, received_at);

create table email_triage_window (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  scope_key   text not null,
  window_hour timestamptz not null,
  count       int not null default 0,
  primary key (tenant_id, scope_key, window_hour)
);

create table email_triage_claims (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  dedup_key        text not null,
  status           text not null check (status in ('processing','done')),
  claimed_at       timestamptz not null default now(),
  replied_at       timestamptz,
  reply_delegated  boolean not null default false,
  primary key (tenant_id, dedup_key)
);

create or replace function resolve_email_recipient(p_envelope_to text)
returns table (tenant_id uuid, agent_slug text, identity_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_local  text := lower(split_part(p_envelope_to, '@', 1));
  v_domain text := lower(split_part(p_envelope_to, '@', 2));
begin
  return query
  select i.tenant_id, i.agent_slug, i.id
  from tenant_agent_email_identity i
  join tenant_inbox_domain d on d.id = i.domain_id
  where d.domain = v_domain
    and lower(i.local_part) = v_local
    and i.status = 'active'
    and d.status = 'active'
  limit 1;
end $$;
revoke all on function resolve_email_recipient(text) from public;

create or replace function email_triage_consume(
  p_tenant_id uuid,
  p_dedup_key text,
  p_from_address text,
  p_tenant_limit int,
  p_sender_limit int
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_claimed_at timestamptz;
  v_hour timestamptz := date_trunc('hour', now());
  v_sender_key text := 'from:' || lower(coalesce(p_from_address, 'unknown'));
  v_tenant_count int;
  v_sender_count int;
begin
  select status, claimed_at into v_status, v_claimed_at
  from email_triage_claims
  where tenant_id = p_tenant_id and dedup_key = p_dedup_key
  for update;

  if not found then
    insert into email_triage_claims (tenant_id, dedup_key, status)
    values (p_tenant_id, p_dedup_key, 'processing');
  elsif v_status = 'done' then
    return 'duplicate';
  elsif v_status = 'processing' and v_claimed_at > now() - interval '5 minutes' then
    return 'in_flight';
  else
    update email_triage_claims set claimed_at = now()
    where tenant_id = p_tenant_id and dedup_key = p_dedup_key;
  end if;

  insert into email_triage_window (tenant_id, scope_key, window_hour, count)
  values (p_tenant_id, v_sender_key, v_hour, 1)
  on conflict (tenant_id, scope_key, window_hour)
  do update set count = email_triage_window.count + 1
  returning count into v_sender_count;
  if v_sender_count > p_sender_limit then
    return 'rate_limited_sender';
  end if;

  insert into email_triage_window (tenant_id, scope_key, window_hour, count)
  values (p_tenant_id, 'tenant', v_hour, 1)
  on conflict (tenant_id, scope_key, window_hour)
  do update set count = email_triage_window.count + 1
  returning count into v_tenant_count;
  if v_tenant_count > p_tenant_limit then
    return 'rate_limited_tenant';
  end if;

  return 'ok';
end $$;
revoke all on function email_triage_consume(uuid, text, text, int, int) from public;

create or replace function ingest_email_message(
  p_tenant_id uuid,
  p_owner_agent_slug text,
  p_owner_identity_id uuid,
  p_root_message_id text,
  p_subject_normalized text,
  p_direction text,
  p_dedup_key text,
  p_envelope_to text,
  p_from_address text,
  p_to_addresses text[],
  p_cc_addresses text[],
  p_rfc_message_id text,
  p_in_reply_to text,
  p_references_chain text[],
  p_subject text,
  p_body_text text,
  p_body_html_sanitized text,
  p_raw_mime_ref text,
  p_spam_verdict text,
  p_auto_submitted boolean,
  p_headers jsonb
) returns table (message_id uuid, thread_id uuid, deduped boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_thread_id uuid;
  v_message_id uuid;
begin
  select id into v_thread_id
  from email_threads
  where tenant_id = p_tenant_id and root_message_id = p_root_message_id;

  if v_thread_id is null then
    insert into email_threads
      (tenant_id, owner_agent_slug, owner_identity_id, root_message_id, subject_normalized, last_message_at)
    values
      (p_tenant_id, p_owner_agent_slug, p_owner_identity_id, p_root_message_id, p_subject_normalized, now())
    returning id into v_thread_id;
  end if;

  insert into email_messages (
    tenant_id, thread_id, direction, provider_message_id, rfc_message_id,
    in_reply_to, references_chain, envelope_to, from_address, to_addresses,
    cc_addresses, subject, body_text, body_html_sanitized, raw_mime_ref,
    spam_verdict, auto_submitted, headers, dedup_key
  ) values (
    p_tenant_id, v_thread_id, p_direction, null, p_rfc_message_id,
    p_in_reply_to, coalesce(p_references_chain, array[]::text[]), p_envelope_to, p_from_address,
    coalesce(p_to_addresses, array[]::text[]), coalesce(p_cc_addresses, array[]::text[]),
    p_subject, p_body_text, p_body_html_sanitized, p_raw_mime_ref,
    p_spam_verdict, coalesce(p_auto_submitted, false), coalesce(p_headers, '{}'::jsonb), p_dedup_key
  )
  on conflict (tenant_id, dedup_key) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select id into v_message_id from email_messages
    where tenant_id = p_tenant_id and dedup_key = p_dedup_key;
    return query select v_message_id, v_thread_id, true;
    return;
  end if;

  update email_threads set last_message_at = now() where id = v_thread_id;
  return query select v_message_id, v_thread_id, false;
end $$;
revoke all on function ingest_email_message(
  uuid, text, uuid, text, text, text, text, text, text, text[], text[],
  text, text, text[], text, text, text, text, text, boolean, jsonb
) from public;

alter table tenant_inbox_domain          enable row level security;
alter table tenant_agent_email_identity  enable row level security;
alter table email_threads                enable row level security;
alter table email_messages               enable row level security;
alter table email_triage_window          enable row level security;
alter table email_triage_claims          enable row level security;

create policy tenant_inbox_domain_member_select on tenant_inbox_domain for select using (
  exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = tenant_inbox_domain.tenant_id)
);
create policy tenant_agent_email_identity_member_select on tenant_agent_email_identity for select using (
  exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = tenant_agent_email_identity.tenant_id)
);
create policy email_threads_member_select on email_threads for select using (
  exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = email_threads.tenant_id)
);
create policy email_messages_member_select on email_messages for select using (
  exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = email_messages.tenant_id)
);
