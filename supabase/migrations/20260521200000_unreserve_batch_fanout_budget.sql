
create table if not exists batch_fanout_refunds (
  batch_id            uuid primary key,
  tenant_id           uuid not null,
  total_reserved      numeric(18, 6) not null,
  estimate_per_child  numeric(18, 6) not null,
  reserved_at         timestamptz not null,
  parent_message_id   uuid,
  refunded_usd        numeric(18, 6) not null,
  refunded_children   integer not null,
  refund_reason       text not null,
  refunded_at         timestamptz not null default now()
);

comment on table batch_fanout_refunds is
  'Append-only refund audit for multi-task fan-out reservations. One row per '
  'refunded batch; batch_id PK = idempotency latch (a second refund of the '
  'same batch finds the reservation row already deleted and no-ops). Copies '
  'the full reservation fields so it is a complete forensic record on its own.';

create index if not exists batch_fanout_refunds_tenant_day_idx
  on batch_fanout_refunds (tenant_id, ((refunded_at at time zone 'utc')::date));

alter table batch_fanout_refunds enable row level security;

alter table batch_fanout_reservations
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_reason text;

update batch_fanout_reservations
   set acknowledged_at = now(),
       acknowledged_reason = 'smoke-2026-05-21-forensic'
 where batch_id = '415c102d-71a2-4cf6-804a-769c2731da98'
   and acknowledged_at is null;

create or replace function unreserve_batch_fanout_budget(
  p_batch_id          uuid,
  p_refund_usd        numeric default null,
  p_actual_spend_usd  numeric default null,
  p_refund_reason     text default 'failed_zero_actual_spend'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ledger        batch_fanout_reservations%rowtype;
  v_today         date;
  v_decrement     numeric;
  v_updated_rows  integer;
begin
  if p_batch_id is null then
    raise exception 'unreserve_batch_fanout_budget: p_batch_id is null'
      using errcode = '22023';
  end if;

  select * into v_ledger
    from batch_fanout_reservations
   where batch_id = p_batch_id
     for update;
  if not found then
    return jsonb_build_object('ok', true, 'reason', 'no_reservation');
  end if;

  v_today := (v_ledger.reserved_at at time zone 'utc')::date;

  if p_actual_spend_usd is not null then
    if p_actual_spend_usd < 0 then
      raise exception
        'unreserve_batch_fanout_budget: p_actual_spend_usd must be >= 0, got %',
        p_actual_spend_usd using errcode = '22023';
    end if;
    v_decrement := greatest(0, v_ledger.total_reserved - p_actual_spend_usd);
  elsif p_refund_usd is not null then
    if p_refund_usd < 0 or p_refund_usd > v_ledger.total_reserved then
      raise exception
        'unreserve_batch_fanout_budget: p_refund_usd % out of range [0, %]',
        p_refund_usd, v_ledger.total_reserved using errcode = '22023';
    end if;
    v_decrement := p_refund_usd;
  else
    v_decrement := v_ledger.total_reserved;
  end if;

  insert into tenant_budget_counters (tenant_id, day)
       values (v_ledger.tenant_id, v_today)
  on conflict (tenant_id, day) do nothing;

  update tenant_budget_counters
     set spend_estimate = greatest(0, spend_estimate - v_decrement),
         run_count      = greatest(0, run_count - v_ledger.child_count),
         updated_at     = now()
   where tenant_id = v_ledger.tenant_id
     and day = v_today;
  get diagnostics v_updated_rows = row_count;
  if v_updated_rows = 0 then
    raise exception
      'unreserve_batch_fanout_budget: counter update affected 0 rows for tenant=% day=%',
      v_ledger.tenant_id, v_today using errcode = 'P0002';
  end if;

  insert into batch_fanout_refunds (
    batch_id, tenant_id, total_reserved, estimate_per_child, reserved_at,
    parent_message_id, refunded_usd, refunded_children, refund_reason, refunded_at
  ) values (
    p_batch_id, v_ledger.tenant_id, v_ledger.total_reserved,
    v_ledger.estimate_per_child, v_ledger.reserved_at, v_ledger.parent_message_id,
    v_decrement, v_ledger.child_count, p_refund_reason, now()
  );

  delete from batch_fanout_reservations where batch_id = p_batch_id;

  return jsonb_build_object(
    'ok', true,
    'refunded_usd', v_decrement,
    'refunded_children', v_ledger.child_count
  );
end $$;

revoke all on function unreserve_batch_fanout_budget(uuid, numeric, numeric, text)
  from public;
grant execute on function unreserve_batch_fanout_budget(uuid, numeric, numeric, text)
  to service_role;
