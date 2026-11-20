
begin;

create table if not exists autopilot_action_ledger (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  conductor_run_id  uuid references conductor_runs(id) on delete set null,
  node_id           text,
  action            text not null
                      check (action in ('dispatch','dispatched','reconcile','dispatch_failed','halted','completed','undo','noop')),
  target_agent_slug text,
  child_run_id      uuid,
  decision_id       uuid,
  spend_delta       numeric not null default 0,
  outcome           text,
  error             text,
  evidence          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists autopilot_action_ledger_conductor_idx
  on autopilot_action_ledger (conductor_run_id, created_at);
create index if not exists autopilot_action_ledger_tenant_idx
  on autopilot_action_ledger (tenant_id, created_at desc);

alter table autopilot_action_ledger enable row level security;
drop policy if exists autopilot_action_ledger_select on autopilot_action_ledger;
create policy autopilot_action_ledger_select on autopilot_action_ledger
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = autopilot_action_ledger.tenant_id)
  );

create or replace function autopilot_action_worm_guard()
returns trigger language plpgsql as $$
begin
  raise exception 'autopilot_action_ledger is append-only (WORM): % blocked', tg_op
    using errcode = '42501';
end $$;

drop trigger if exists autopilot_action_ledger_worm on autopilot_action_ledger;
create trigger autopilot_action_ledger_worm
  before update or delete on autopilot_action_ledger
  for each row execute function autopilot_action_worm_guard();

create or replace function append_autopilot_action(
  p_tenant_id         uuid,
  p_conductor_run_id  uuid,
  p_node_id           text,
  p_action            text,
  p_target_agent_slug text,
  p_child_run_id      uuid,
  p_decision_id       uuid,
  p_spend_delta       numeric,
  p_outcome           text,
  p_error             text,
  p_evidence          jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_action is null then
    raise exception 'append_autopilot_action: tenant_id and action are required'
      using errcode = '22023';
  end if;
  insert into autopilot_action_ledger (
    tenant_id, conductor_run_id, node_id, action, target_agent_slug,
    child_run_id, decision_id, spend_delta, outcome, error, evidence
  ) values (
    p_tenant_id, p_conductor_run_id, p_node_id, p_action, p_target_agent_slug,
    p_child_run_id, p_decision_id, coalesce(p_spend_delta, 0), p_outcome, p_error,
    coalesce(p_evidence, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end $$;

revoke all on function append_autopilot_action(uuid, uuid, text, text, text, uuid, uuid, numeric, text, text, jsonb) from public;
grant execute on function append_autopilot_action(uuid, uuid, text, text, text, uuid, uuid, numeric, text, text, jsonb) to service_role;

commit;
