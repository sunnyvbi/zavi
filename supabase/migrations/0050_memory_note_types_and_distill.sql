

alter table memory_note
  add column note_type text not null default 'untyped'
  check (note_type in (
    'operator_preference',
    'agent_feedback',
    'tenant_project',
    'tenant_reference',
    'untyped'
  ));

create index memory_note_tenant_type_idx
  on memory_note (tenant_id, note_type, updated_at desc);

update memory_note
   set note_type = 'agent_feedback'
 where source in ('operator_feedback', 'praxis_staff')
   and note_type = 'untyped';

alter table memory_note
  drop constraint if exists memory_note_source_check;

alter table memory_note
  add constraint memory_note_source_check check (
    source in (
      'human',
      'agent_run',
      'slack_distill',
      'email_distill',
      'operator_feedback',
      'praxis_staff',
      'auto_distill_chat',
      'auto_distill_agent_run',
      'auto_distill_slack',
      'dream_cycle_merge',
      'agent_write'
    )
  );

alter table agent_runs
  add column distilled_at timestamptz;

create index agent_runs_distillable_idx
  on agent_runs (tenant_id, finished_at)
  where distilled_at is null and status = 'success';

alter table agent_thread_messages
  add column distilled_at timestamptz;

create index agent_thread_messages_distillable_idx
  on agent_thread_messages (thread_id, created_at)
  where distilled_at is null and sender_role = 'user';

create index ingested_events_undistilled_idx
  on ingested_events (tenant_id, received_at)
  where distilled_at is null;

create table memory_note_entity (
  tenant_id uuid not null references tenants(id) on delete cascade,
  note_id uuid not null references memory_note(id) on delete cascade,
  entity_id uuid not null references memory_entity(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  primary key (tenant_id, note_id, entity_id)
);

create index memory_note_entity_by_entity
  on memory_note_entity (tenant_id, entity_id, first_seen_at desc);

alter table memory_note_entity enable row level security;

create policy memory_note_entity_member_select on memory_note_entity
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = memory_note_entity.tenant_id)
  );

