

alter table slack_channels
  add column if not exists last_summary_attempted_at timestamptz,
  add column if not exists last_summary_cents int,
  add column if not exists summary_sidecar jsonb;

create index if not exists slack_channels_attempt_idx
  on slack_channels (tenant_id, last_summary_attempted_at asc nulls first);

create or replace function slack_summary_budget_reconcile(
  p_tenant_id      uuid,
  p_estimated_cents int,
  p_actual_cents    int,
  p_cap_cents       int
) returns table (new_cents int, over boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_delta int := p_actual_cents - p_estimated_cents;
  v_cents int;
begin
  if v_delta = 0 then
    select cents into v_cents from slack_summary_budget_ledger
      where tenant_id = p_tenant_id and day = current_date;
    return query select coalesce(v_cents, 0), false;
    return;
  end if;
  update slack_summary_budget_ledger
     set cents = cents + v_delta
   where tenant_id = p_tenant_id and day = current_date
   returning cents into v_cents;
  return query select coalesce(v_cents, p_actual_cents),
    coalesce(v_cents, p_actual_cents) > p_cap_cents;
end $$;

revoke all on function slack_summary_budget_reconcile(uuid, int, int, int) from public;
grant execute on function slack_summary_budget_reconcile(uuid, int, int, int) to service_role;

create unique index if not exists staff_audit_log_slack_iq_idempotency_idx
  on staff_audit_log ((meta->>'idempotency_key'))
  where action in ('slack_channel_discovered', 'slack_auto_join',
                   'slack_auto_join_failed', 'slack_summarize_run',
                   'slack_summarize_cap_hit')
    and meta ? 'idempotency_key';
