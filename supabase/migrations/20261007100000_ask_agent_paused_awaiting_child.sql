
begin;

create table if not exists agent_asks (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  parent_run_id      uuid not null references agent_runs(id) on delete cascade,
  child_run_id       uuid references agent_runs(id) on delete cascade,
  parent_agent_slug  text not null,
  target_agent_slug  text not null,
  tool_use_id        text,
  surface            text not null,
  deadline_at        timestamptz not null,
  outcome            text check (outcome in ('answer', 'timeout')),
  claimed_at         timestamptz,
  resume_run_id      uuid,
  resumed_at         timestamptz,
  late_posted_at     timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz not null default now()
);

create unique index if not exists agent_asks_parent_uq on agent_asks (parent_run_id);
create unique index if not exists agent_asks_child_uq
  on agent_asks (child_run_id) where child_run_id is not null;
create index if not exists agent_asks_open_deadline_idx
  on agent_asks (deadline_at)
  where late_posted_at is null and closed_at is null;

alter table agent_asks enable row level security;

comment on table agent_asks is
  'praxis__ask_agent: one row per ask. outcome is the single atomic continuation claim (answer vs timeout). Service-role only.';

create or replace function _trg_finalize_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not _credits_enforced(NEW.tenant_id)
     and not exists (
       select 1 from tenant_credit_ledger r
       where r.run_id = NEW.id and r.kind = 'reserve'
         and not exists (
           select 1 from tenant_credit_ledger t
           where t.run_id = NEW.id and t.kind in ('settle','refund') and t.attempt = r.attempt
         )
     ) then
    return null;
  end if;
  if OLD.status in ('queued','running','blocked')
     and NEW.status in ('success','parse_failed','error','failed','cancelled','dispatch_error','paused_awaiting_approval','paused_awaiting_child') then
    perform finalize_run_credits(
      NEW.id,
      NEW.cost_usd,
      case when NEW.status = 'paused_awaiting_child' then 'success' else NEW.status end
    );
  end if;
  return null;
end $$;

revoke all on function _trg_finalize_run_credits() from public, anon, authenticated;

do $$
begin
  raise notice '20261007100000: agent_asks + finalize trigger settles running->paused_awaiting_child';
end $$;

commit;
