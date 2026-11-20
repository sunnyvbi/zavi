
create table if not exists low_conf_dispatches (
  tenant_id          uuid        not null references tenants(id) on delete cascade,
  channel_id         text        not null,
  thread_ts          text        not null,
  source_message_ts  text        not null,
  run_id             uuid,
  status             text        not null
                                 default 'pending_reply'
                                 check (status in ('pending_reply', 'replied', 'recovered', 'enqueue_failed')),
  dispatched_at      timestamptz not null default now(),
  replied_at         timestamptz,
  recovered_at       timestamptz,
  primary key (tenant_id, channel_id, thread_ts, source_message_ts)
);

create index if not exists low_conf_dispatches_pending_idx
  on low_conf_dispatches (dispatched_at)
  where status = 'pending_reply';

create index if not exists low_conf_dispatches_run_id_idx
  on low_conf_dispatches (run_id)
  where run_id is not null;

alter table low_conf_dispatches enable row level security;

revoke all on low_conf_dispatches from public, authenticated, anon;
