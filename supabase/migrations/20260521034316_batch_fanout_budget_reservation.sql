
update system_config
   set blob = jsonb_set(blob, '{batch_fanout_tenant_allowlist}', '[]'::jsonb)
 where id = 1
   and not (blob ? 'batch_fanout_tenant_allowlist');

comment on column system_config.blob is
  'Singleton feature-flag store. batch_fanout_tenant_allowlist is a jsonb '
  'string[] of tenant UUIDs allowed to use multi-task fan-out (default: []).';

create table if not exists batch_fanout_reservations (
  batch_id           uuid primary key,
  tenant_id          uuid not null references tenants(id) on delete cascade,
  parent_message_id  uuid,
  child_count        int  not null check (child_count > 0 and child_count <= 4),
  estimate_per_child numeric(18, 6) not null check (estimate_per_child >= 0),
  total_reserved     numeric(18, 6) generated always as
                       (estimate_per_child * child_count) stored,
  reserved_at        timestamptz not null default now()
);

comment on table batch_fanout_reservations is
  'Per-batch budget reservation ledger. batch_id PK = idempotency key. '
  'INSERT ON CONFLICT (batch_id) DO NOTHING in the RPC keeps approval '
  'retries from double-charging tenant_budget_counters.';

create index if not exists batch_fanout_reservations_tenant_day_idx
  on batch_fanout_reservations (tenant_id, ((reserved_at at time zone 'utc')::date));

alter table batch_fanout_reservations enable row level security;

create or replace function reserve_batch_fanout_budget_or_reject(
  p_tenant_id            uuid,
  p_batch_id             uuid,
  p_parent_message_id    uuid,
  p_child_count          int,
  p_estimate_usd_per_child numeric,
  p_daily_child_cap      int,
  p_daily_usd_cap        numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing       batch_fanout_reservations%rowtype;
  v_today          date := (now() at time zone 'utc')::date;
  v_total          numeric;
  v_current_kids   int;
  v_spend_after    numeric;
begin
  if p_tenant_id is null
     or p_batch_id is null
     or p_child_count is null
     or p_estimate_usd_per_child is null then
    raise exception 'reserve_batch_fanout_budget_or_reject: null argument'
      using errcode = '22023';
  end if;
  if p_child_count <= 0 or p_child_count > 4 then
    raise exception
      'reserve_batch_fanout_budget_or_reject: child_count must be 1..4'
      using errcode = '22023';
  end if;
  if p_estimate_usd_per_child < 0 then
    raise exception
      'reserve_batch_fanout_budget_or_reject: estimate_per_child must be >= 0'
      using errcode = '22023';
  end if;

  v_total := p_estimate_usd_per_child * p_child_count;

  insert into tenant_budget_counters (tenant_id, day)
       values (p_tenant_id, v_today)
  on conflict (tenant_id, day) do nothing;
  perform 1
     from tenant_budget_counters
    where tenant_id = p_tenant_id
      and day = v_today
      for update;

  select * into v_existing
    from batch_fanout_reservations
   where batch_id = p_batch_id;
  if found then
    return jsonb_build_object(
      'ok', true,
      'reserved_usd', v_existing.total_reserved,
      'idempotent_retry', true,
      'reason', 'already_reserved'
    );
  end if;

  if p_daily_child_cap > 0 then
    select coalesce(sum(child_count), 0) into v_current_kids
      from batch_fanout_reservations
     where tenant_id = p_tenant_id
       and (reserved_at at time zone 'utc')::date = v_today;
    if (v_current_kids + p_child_count) > p_daily_child_cap then
      return jsonb_build_object(
        'ok', false,
        'reason', 'daily_child_cap_exceeded',
        'cap', p_daily_child_cap,
        'current', v_current_kids,
        'requested', p_child_count
      );
    end if;
  end if;

  update tenant_budget_counters
     set spend_estimate = spend_estimate + v_total,
         run_count      = run_count + p_child_count,
         updated_at     = now()
   where tenant_id = p_tenant_id
     and day = v_today
     and (p_daily_usd_cap <= 0 or spend_estimate + v_total <= p_daily_usd_cap)
   returning spend_estimate into v_spend_after;

  if v_spend_after is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'daily_usd_cap_exceeded',
      'cap', p_daily_usd_cap,
      'requested_usd', v_total
    );
  end if;

  begin
    insert into batch_fanout_reservations
           (batch_id, tenant_id, parent_message_id, child_count, estimate_per_child)
    values (p_batch_id, p_tenant_id, p_parent_message_id, p_child_count,
            p_estimate_usd_per_child);
  exception
    when unique_violation then
      update tenant_budget_counters
         set spend_estimate = spend_estimate - v_total,
             run_count      = run_count - p_child_count,
             updated_at     = now()
       where tenant_id = p_tenant_id
         and day = v_today;
      select * into v_existing
        from batch_fanout_reservations
       where batch_id = p_batch_id;
      return jsonb_build_object(
        'ok', true,
        'reserved_usd', v_existing.total_reserved,
        'idempotent_retry', true,
        'reason', 'already_reserved_concurrent'
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'reserved_usd', v_total,
    'remaining_usd',
      case when p_daily_usd_cap > 0
           then greatest(0, p_daily_usd_cap - v_spend_after)
           else null
      end,
    'idempotent_retry', false
  );
end $$;

revoke all on function reserve_batch_fanout_budget_or_reject(
  uuid, uuid, uuid, int, numeric, int, numeric
) from public;
grant execute on function reserve_batch_fanout_budget_or_reject(
  uuid, uuid, uuid, int, numeric, int, numeric
) to service_role;
