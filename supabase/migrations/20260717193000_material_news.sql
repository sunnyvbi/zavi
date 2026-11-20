
begin;

create table if not exists news_topics (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  topics       jsonb not null default '{"terms": []}'::jsonb,
  refreshed_at timestamptz not null default now()
);
alter table news_topics enable row level security;

create table if not exists news_findings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  normalized_url text not null,
  source_host    text,
  headline       text not null,
  why            text not null,
  anchor_id      uuid,
  score          numeric not null,
  published_at   timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_emailed_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (tenant_id, normalized_url)
);
create index if not exists news_findings_tenant_pending_idx
  on news_findings (tenant_id)
  where last_emailed_at is null;
alter table news_findings enable row level security;

create table if not exists news_scan_claims (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  scan_day   date not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, scan_day)
);
alter table news_scan_claims enable row level security;

create table if not exists news_digest_deliveries (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  send_day   date not null,
  status     text not null check (status in ('claimed', 'sent', 'failed')),
  claimed_at timestamptz not null default now(),
  sent_at    timestamptz,
  attempt_id uuid,
  unique (tenant_id, send_day)
);
create index if not exists news_digest_deliveries_cooldown_idx
  on news_digest_deliveries (tenant_id, sent_at)
  where status = 'sent';
alter table news_digest_deliveries enable row level security;

create table if not exists material_news_emitted (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  phase        text not null,
  normalized_url text,
  score        numeric,
  anchor_id    uuid,
  skip_reason  text,
  created_at   timestamptz not null default now()
);
create index if not exists material_news_emitted_tenant_idx
  on material_news_emitted (tenant_id, created_at);
alter table material_news_emitted enable row level security;

create or replace function claim_news_scan_day(
  p_tenant_id uuid,
  p_scan_day  date
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_scan_day is null then
    raise exception 'claim_news_scan_day: null argument' using errcode = '22023';
  end if;
  insert into news_scan_claims (tenant_id, scan_day)
  values (p_tenant_id, p_scan_day)
  on conflict (tenant_id, scan_day) do nothing;
  return found;
end;
$$;
revoke all on function claim_news_scan_day(uuid, date) from public;
grant execute on function claim_news_scan_day(uuid, date) to service_role;

create or replace function claim_news_digest_send(
  p_tenant_id uuid,
  p_send_day  date
) returns table (id uuid, is_fresh boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_send_day is null then
    raise exception 'claim_news_digest_send: null argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mnews:' || p_tenant_id::text, 0));

  if exists (
    select 1 from news_digest_deliveries
     where tenant_id = p_tenant_id
       and status in ('claimed', 'sent')
       and coalesce(sent_at, claimed_at) > now() - interval '7 days'
  ) then
    raise exception 'cooldown' using errcode = 'P0001';
  end if;

  return query
  insert into news_digest_deliveries (tenant_id, send_day, status, attempt_id)
  values (p_tenant_id, p_send_day, 'claimed', gen_random_uuid())
  on conflict (tenant_id, send_day)
    do update set claimed_at = now()
    where news_digest_deliveries.status = 'claimed'
  returning news_digest_deliveries.id, (xmax = 0);

  if not found then
    raise exception 'already_finalized' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function claim_news_digest_send(uuid, date) from public;
grant execute on function claim_news_digest_send(uuid, date) to service_role;

create or replace function mark_news_digest_sent(
  p_id          uuid,
  p_tenant_id   uuid,
  p_status      text,
  p_finding_ids uuid[] default '{}'
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_id is null or p_tenant_id is null or p_status is null then
    raise exception 'mark_news_digest_sent: null argument' using errcode = '22023';
  end if;
  if p_status not in ('sent', 'failed') then
    raise exception 'mark_news_digest_sent: bad status' using errcode = '22023';
  end if;
  update news_digest_deliveries
     set status  = p_status,
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id and tenant_id = p_tenant_id;
  if p_status = 'sent' and p_finding_ids is not null and array_length(p_finding_ids, 1) > 0 then
    update news_findings
       set last_emailed_at = now()
     where tenant_id = p_tenant_id
       and id = any(p_finding_ids)
       and last_emailed_at is null;
  end if;
end;
$$;
revoke all on function mark_news_digest_sent(uuid, uuid, text, uuid[]) from public;
grant execute on function mark_news_digest_sent(uuid, uuid, text, uuid[]) to service_role;

commit;
