
create table handoff_batches (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  parent_run_id        uuid not null references agent_runs(id) on delete cascade,
  batch_id             uuid not null,
  operator_thread_id   uuid not null,
  child_run_ids        uuid[] not null,
  deadline_at          timestamptz not null,
  status               text not null default 'pending'
                         check (status in ('pending','synthesized','timed_out')),
  posted_at            timestamptz,
  created_at           timestamptz not null default now()
);

create unique index handoff_batches_parent_batch_uq
  on handoff_batches (parent_run_id, batch_id);

create index handoff_batches_batch_idx on handoff_batches (batch_id);
create index handoff_batches_pending_idx
  on handoff_batches (deadline_at) where status = 'pending';

alter table handoff_batches enable row level security;

create or replace function claim_handoff_batch(
  p_batch_id   uuid,
  p_new_status text
) returns uuid
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  if p_new_status not in ('synthesized','timed_out') then
    raise exception 'claim_handoff_batch: invalid status %', p_new_status
      using errcode = 'check_violation';
  end if;

  update handoff_batches
     set status = p_new_status,
         posted_at = now()
   where batch_id = p_batch_id
     and status = 'pending'
   returning id into claimed_id;

  return claimed_id;
end;
$$;
