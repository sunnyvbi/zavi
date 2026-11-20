begin;

create table if not exists channel_mention_alerts_sent (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  channel     text not null,
  mention_key text not null,
  alerted_at  timestamptz not null default now(),
  primary key (tenant_id, channel, mention_key)
);
create index if not exists channel_mention_alerts_sent_tenant_idx
  on channel_mention_alerts_sent (tenant_id, alerted_at desc);
alter table channel_mention_alerts_sent enable row level security;

create table if not exists channel_mention_alert_deliveries (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  send_day   date not null,
  status     text not null check (status in ('claimed', 'sent', 'failed')),
  channels   text[] not null default '{}',
  mentions   int not null default 0,
  claimed_at timestamptz not null default now(),
  sent_at    timestamptz,
  attempt_id uuid,
  unique (tenant_id, send_day)
);
create index if not exists channel_mention_alert_deliveries_cooldown_idx
  on channel_mention_alert_deliveries (tenant_id, sent_at)
  where status = 'sent';
alter table channel_mention_alert_deliveries enable row level security;

create or replace function claim_mention_alert_send(
  p_tenant_id uuid,
  p_send_day  date
) returns table (id uuid, is_fresh boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_send_day is null then
    raise exception 'claim_mention_alert_send: null argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mention_alert:' || p_tenant_id::text, 0));

  if exists (
    select 1 from channel_mention_alert_deliveries
     where tenant_id = p_tenant_id
       and status in ('claimed', 'sent')
       and coalesce(sent_at, claimed_at) > now() - interval '20 hours'
  ) then
    raise exception 'cooldown' using errcode = 'P0001';
  end if;

  return query
  insert into channel_mention_alert_deliveries (tenant_id, send_day, status, attempt_id)
  values (p_tenant_id, p_send_day, 'claimed', gen_random_uuid())
  on conflict (tenant_id, send_day)
    do update set claimed_at = now(),
                  status     = 'claimed',
                  attempt_id = gen_random_uuid()
    where channel_mention_alert_deliveries.status = 'failed'
  returning channel_mention_alert_deliveries.id, true;

  if not found then
    raise exception 'already_finalized' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function claim_mention_alert_send(uuid, date) from public, anon, authenticated;
grant execute on function claim_mention_alert_send(uuid, date) to service_role;

create or replace function mark_mention_alert_sent(
  p_id        uuid,
  p_tenant_id uuid,
  p_status    text,
  p_mentions  jsonb default '[]'::jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int := 0;
  v_channels text[] := '{}';
begin
  if p_id is null or p_tenant_id is null or p_status is null then
    raise exception 'mark_mention_alert_sent: null argument' using errcode = '22023';
  end if;
  if p_status not in ('sent', 'failed') then
    raise exception 'mark_mention_alert_sent: bad status' using errcode = '22023';
  end if;

  if p_status = 'sent' and jsonb_typeof(p_mentions) = 'array' then
    insert into channel_mention_alerts_sent (tenant_id, channel, mention_key)
    select p_tenant_id, m.channel, m.mention_key
      from jsonb_to_recordset(p_mentions) as m(channel text, mention_key text)
     where m.channel is not null and m.mention_key is not null
    on conflict (tenant_id, channel, mention_key) do nothing;

    select count(*)::int, coalesce(array_agg(distinct m.channel), '{}')
      into v_count, v_channels
      from jsonb_to_recordset(p_mentions) as m(channel text, mention_key text)
     where m.channel is not null and m.mention_key is not null;
  end if;

  update channel_mention_alert_deliveries
     set status   = p_status,
         sent_at  = case when p_status = 'sent' then now() else sent_at end,
         mentions = case when p_status = 'sent' then v_count else mentions end,
         channels = case when p_status = 'sent' then v_channels else channels end
   where id = p_id and tenant_id = p_tenant_id;
end;
$$;
revoke all on function mark_mention_alert_sent(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function mark_mention_alert_sent(uuid, uuid, text, jsonb) to service_role;

commit;
