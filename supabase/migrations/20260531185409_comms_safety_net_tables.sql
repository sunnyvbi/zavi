
create table if not exists comms_unsubscribes (
  tenant_id  uuid        not null,
  channel    text        not null
             check (channel in ('email', 'sms', 'slack_dm')),
  recipient  text        not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, channel, recipient)
);
alter table comms_unsubscribes enable row level security;
drop policy if exists comms_unsubscribes_select on comms_unsubscribes;
create policy comms_unsubscribes_select on comms_unsubscribes
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = comms_unsubscribes.tenant_id)
  );

create table if not exists comms_suppressions (
  tenant_id  uuid        not null,
  channel    text        not null
             check (channel in ('email', 'sms', 'slack_dm')),
  recipient  text        not null,
  reason     text        not null default 'manual'
             check (reason in ('bounce', 'complaint', 'manual', 'legal_hold')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, channel, recipient)
);
alter table comms_suppressions enable row level security;
drop policy if exists comms_suppressions_select on comms_suppressions;
create policy comms_suppressions_select on comms_suppressions
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = comms_suppressions.tenant_id)
  );

create table if not exists comms_send_log (
  id         bigint      generated always as identity primary key,
  tenant_id  uuid        not null,
  channel    text        not null
             check (channel in ('email', 'sms', 'slack_dm')),
  recipient  text        not null,
  sent_at    timestamptz not null default now()
);
create index if not exists comms_send_log_tenant_channel_sent_idx
  on comms_send_log (tenant_id, channel, sent_at desc);
alter table comms_send_log enable row level security;
drop policy if exists comms_send_log_select on comms_send_log;
create policy comms_send_log_select on comms_send_log
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = comms_send_log.tenant_id)
  );

create table if not exists comms_caps (
  tenant_id   uuid        not null,
  channel     text        not null
              check (channel in ('email', 'sms', 'slack_dm')),
  max_per_24h int         check (max_per_24h is null or max_per_24h >= 0),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, channel)
);
alter table comms_caps enable row level security;
drop policy if exists comms_caps_select on comms_caps;
create policy comms_caps_select on comms_caps
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = comms_caps.tenant_id)
  );

create or replace function comms_is_unsubscribed(
  p_tenant_id uuid,
  p_channel   text,
  p_recipient text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_channel is null or p_recipient is null then
    raise exception 'comms_is_unsubscribed: null argument' using errcode = '22023';
  end if;
  return exists (
    select 1 from comms_unsubscribes
     where tenant_id = p_tenant_id and channel = p_channel and recipient = p_recipient
  );
end $$;
revoke all on function comms_is_unsubscribed(uuid, text, text) from public;
grant execute on function comms_is_unsubscribed(uuid, text, text) to service_role;

create or replace function comms_is_suppressed(
  p_tenant_id uuid,
  p_channel   text,
  p_recipient text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_reason text;
begin
  if p_tenant_id is null or p_channel is null or p_recipient is null then
    raise exception 'comms_is_suppressed: null argument' using errcode = '22023';
  end if;
  select reason into v_reason
    from comms_suppressions
   where tenant_id = p_tenant_id and channel = p_channel and recipient = p_recipient;
  return v_reason;
end $$;
revoke all on function comms_is_suppressed(uuid, text, text) from public;
grant execute on function comms_is_suppressed(uuid, text, text) to service_role;

create or replace function comms_unsubscribe(
  p_tenant_id uuid,
  p_channel   text,
  p_recipient text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_channel is null or p_recipient is null then
    raise exception 'comms_unsubscribe: null argument' using errcode = '22023';
  end if;
  if p_channel not in ('email', 'sms', 'slack_dm') then
    raise exception 'comms_unsubscribe: invalid channel %', p_channel using errcode = '22023';
  end if;
  insert into comms_unsubscribes (tenant_id, channel, recipient)
  values (p_tenant_id, p_channel, p_recipient)
  on conflict (tenant_id, channel, recipient) do nothing;
end $$;
revoke all on function comms_unsubscribe(uuid, text, text) from public;
grant execute on function comms_unsubscribe(uuid, text, text) to service_role;

create or replace function comms_suppress(
  p_tenant_id uuid,
  p_channel   text,
  p_recipient text,
  p_reason    text default 'manual'
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_channel is null or p_recipient is null then
    raise exception 'comms_suppress: null argument' using errcode = '22023';
  end if;
  if p_channel not in ('email', 'sms', 'slack_dm') then
    raise exception 'comms_suppress: invalid channel %', p_channel using errcode = '22023';
  end if;
  if p_reason not in ('bounce', 'complaint', 'manual', 'legal_hold') then
    raise exception 'comms_suppress: invalid reason %', p_reason using errcode = '22023';
  end if;
  insert into comms_suppressions (tenant_id, channel, recipient, reason)
  values (p_tenant_id, p_channel, p_recipient, p_reason)
  on conflict (tenant_id, channel, recipient) do update
    set reason = excluded.reason;
end $$;
revoke all on function comms_suppress(uuid, text, text, text) from public;
grant execute on function comms_suppress(uuid, text, text, text) to service_role;

create or replace function comms_rolling_24h_count(
  p_tenant_id uuid,
  p_channel   text
) returns table (sent24h int, cap int)
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_channel is null then
    raise exception 'comms_rolling_24h_count: null argument' using errcode = '22023';
  end if;
  return query
    select
      (select count(*)::int
         from comms_send_log
        where tenant_id = p_tenant_id
          and channel = p_channel
          and sent_at >= now() - interval '24 hours'),
      (select max_per_24h
         from comms_caps
        where tenant_id = p_tenant_id and channel = p_channel);
end $$;
revoke all on function comms_rolling_24h_count(uuid, text) from public;
grant execute on function comms_rolling_24h_count(uuid, text) to service_role;

create or replace function comms_set_cap(
  p_tenant_id   uuid,
  p_channel     text,
  p_max_per_24h int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_channel is null then
    raise exception 'comms_set_cap: null argument' using errcode = '22023';
  end if;
  if p_channel not in ('email', 'sms', 'slack_dm') then
    raise exception 'comms_set_cap: invalid channel %', p_channel using errcode = '22023';
  end if;
  insert into comms_caps (tenant_id, channel, max_per_24h, updated_at)
  values (p_tenant_id, p_channel, p_max_per_24h, now())
  on conflict (tenant_id, channel) do update
    set max_per_24h = excluded.max_per_24h, updated_at = now();
end $$;
revoke all on function comms_set_cap(uuid, text, int) from public;
grant execute on function comms_set_cap(uuid, text, int) to service_role;

create or replace function consume_comms_send_or_reject(
  p_tenant_id uuid,
  p_channel   text,
  p_recipient text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_cap   int;
  v_count int;
begin
  if p_tenant_id is null or p_channel is null or p_recipient is null then
    raise exception 'consume_comms_send_or_reject: null argument' using errcode = '22023';
  end if;
  if p_channel not in ('email', 'sms', 'slack_dm') then
    raise exception 'consume_comms_send_or_reject: invalid channel %', p_channel using errcode = '22023';
  end if;

  insert into comms_caps (tenant_id, channel, max_per_24h)
  values (p_tenant_id, p_channel, null)
  on conflict (tenant_id, channel) do nothing;

  select max_per_24h into v_cap
    from comms_caps
   where tenant_id = p_tenant_id and channel = p_channel
   for update;

  if v_cap is not null then
    select count(*) into v_count
      from comms_send_log
     where tenant_id = p_tenant_id
       and channel = p_channel
       and sent_at >= now() - interval '24 hours';
    if v_count + 1 > v_cap then
      return false;
    end if;
  end if;

  insert into comms_send_log (tenant_id, channel, recipient)
  values (p_tenant_id, p_channel, p_recipient);

  return true;
end $$;
revoke all on function consume_comms_send_or_reject(uuid, text, text) from public;
grant execute on function consume_comms_send_or_reject(uuid, text, text) to service_role;
