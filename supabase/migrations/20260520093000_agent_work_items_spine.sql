
create table if not exists agent_work_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  agent_slug      text not null,
  source          text not null,
  priority        int  not null default 0,
  status          text not null default 'pending',
  lease_owner     text,
  lease_expires_at timestamptz,
  attempts        int  not null default 0,
  risk_tier       text,
  payload         jsonb,
  dedupe_key      text,
  agent_run_id    uuid,
  last_error      text,
  next_run_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agent_work_items_claim_idx
  on agent_work_items (status, next_run_at, priority desc)
  where status = 'pending';

create index if not exists agent_work_items_tenant_idx
  on agent_work_items (tenant_id, created_at desc);

create unique index if not exists agent_work_items_dedupe_uq
  on agent_work_items (tenant_id, agent_slug, dedupe_key)
  where dedupe_key is not null and status in ('pending', 'leased');

alter table agent_work_items enable row level security;

drop policy if exists agent_work_items_select on agent_work_items;
create policy agent_work_items_select on agent_work_items
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = agent_work_items.tenant_id)
  );

create or replace function enqueue_work_item(
  p_tenant_id   uuid,
  p_agent_slug  text,
  p_source      text,
  p_payload     jsonb default null,
  p_dedupe_key  text default null,
  p_priority    int  default 0,
  p_next_run_at timestamptz default now(),
  p_risk_tier   text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_source in ('chat', 'manual') then
    if not exists (select 1 from tenant_users
                   where user_id = auth.uid() and tenant_id = p_tenant_id) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into agent_work_items (tenant_id, agent_slug, source, payload,
                               dedupe_key, priority, next_run_at, risk_tier)
  values (p_tenant_id, p_agent_slug, p_source, p_payload,
          p_dedupe_key, p_priority, p_next_run_at, p_risk_tier)
  on conflict (tenant_id, agent_slug, dedupe_key)
    where dedupe_key is not null and status in ('pending', 'leased')
    do nothing
  returning id into v_id;

  if v_id is null and p_dedupe_key is not null then
    select id into v_id from agent_work_items
    where tenant_id = p_tenant_id and agent_slug = p_agent_slug
      and dedupe_key = p_dedupe_key and status in ('pending', 'leased')
    order by created_at desc limit 1;
  end if;

  return v_id;
end $$;
revoke all on function enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text) from public;
grant execute on function enqueue_work_item(uuid, text, text, jsonb, text, int, timestamptz, text) to authenticated, service_role;

create or replace function claim_agent_work_items(
  p_owner        text,
  p_limit        int default 10,
  p_lease_seconds int default 300
) returns setof agent_work_items
language plpgsql security definer set search_path = public as $$
begin
  return query
  update agent_work_items w
     set status = 'leased',
         lease_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = w.attempts + 1,
         updated_at = now()
   where w.id in (
     select id from agent_work_items
      where status = 'pending' and next_run_at <= now()
      order by priority desc, next_run_at asc
      limit p_limit
      for update skip locked
   )
  returning w.*;
end $$;
revoke all on function claim_agent_work_items(text, int, int) from public;
grant execute on function claim_agent_work_items(text, int, int) to service_role;

create or replace function complete_work_item(
  p_id           uuid,
  p_status       text,
  p_agent_run_id uuid default null,
  p_last_error   text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('done', 'failed', 'dropped') then
    raise exception 'invalid terminal status %', p_status using errcode = '22023';
  end if;
  update agent_work_items
     set status = p_status,
         agent_run_id = coalesce(p_agent_run_id, agent_run_id),
         last_error = p_last_error,
         lease_owner = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_id;
end $$;
revoke all on function complete_work_item(uuid, text, uuid, text) from public;
grant execute on function complete_work_item(uuid, text, uuid, text) to service_role;
