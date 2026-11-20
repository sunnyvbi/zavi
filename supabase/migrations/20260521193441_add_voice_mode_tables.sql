

create type voice_session_status as enum ('active', 'ended', 'reaped');

create type voice_session_end_reason as enum (
  'user_ended',
  'budget_exhausted',
  'idle_reaped',
  'error',
  'first_wins_displaced',
  'livekit_disconnect',
  'tab_suspended'
);

create type voice_message_content_kind as enum ('text', 'image', 'voice_transcript');

create type voice_turn_state as enum (
  'listening',
  'transcribing',
  'thinking',
  'speaking',
  'failed_retryable',
  'failed_terminal'
);

create table voice_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_slug text not null,
  thread_id uuid not null references agent_threads(id) on delete restrict,
  livekit_room text not null,
  status voice_session_status not null default 'active',
  current_turn_state voice_turn_state,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason voice_session_end_reason
);

create unique index voice_sessions_one_active_per_user
  on voice_sessions (tenant_id, user_id)
  where status = 'active';

create index voice_sessions_tenant_started
  on voice_sessions (tenant_id, started_at desc);

create table voice_session_costs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  session_id uuid not null references voice_sessions(id) on delete cascade,
  agent_run_id uuid references agent_runs(id) on delete set null,
  agent_slug text not null,
  minute_bucket timestamptz not null,
  stt_ms integer not null default 0,
  stt_micros bigint not null default 0,
  tts_chars integer not null default 0,
  tts_micros bigint not null default 0,
  llm_input_tok integer not null default 0,
  llm_output_tok integer not null default 0,
  llm_micros bigint not null default 0,
  created_at timestamptz not null default now()
);

create unique index voice_session_costs_idempotent
  on voice_session_costs (
    session_id,
    minute_bucket,
    coalesce(agent_run_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index voice_session_costs_tenant_created
  on voice_session_costs (tenant_id, created_at desc);

create table voice_callback_events_seen (
  event_id uuid primary key,
  seen_at timestamptz not null default now()
);

create index voice_callback_events_seen_at
  on voice_callback_events_seen (seen_at);

alter table voice_callback_events_seen enable row level security;

alter table agent_thread_messages
  add column if not exists content_kind voice_message_content_kind not null default 'text',
  add column if not exists stt_confidence numeric,
  add column if not exists voice_started_at timestamptz,
  add column if not exists voice_ended_at timestamptz;

alter table tenants
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table voice_sessions enable row level security;

create policy voice_sessions_tenant_read on voice_sessions
  for select
  using (
    tenant_id in (
      select tu.tenant_id from tenant_users tu where tu.user_id = auth.uid()
    )
  );

alter table voice_session_costs enable row level security;

create policy voice_session_costs_tenant_read on voice_session_costs
  for select
  using (
    tenant_id in (
      select tu.tenant_id from tenant_users tu where tu.user_id = auth.uid()
    )
  );

update system_config
set blob = blob
        || case when blob -> 'voice_enabled' is null
                then jsonb_build_object('voice_enabled', false)
                else '{}'::jsonb end
        || case when blob -> 'disabled_voice_agent_slugs' is null
                then jsonb_build_object('disabled_voice_agent_slugs', '[]'::jsonb)
                else '{}'::jsonb end
where id = 1;
