
create table tenant_meeting_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  enabled boolean not null default false,
  meeting_url text not null default '',
  days_of_week int[] not null default array[1,2,3,4,5],
  join_time text not null default '09:30',
  timezone text not null default 'America/Los_Angeles',
  bot_name text not null default 'Zavi Notetaker',
  consent_message text not null default
    'Zavi Notetaker is recording and transcribing this meeting to brief your AI team. Important decisions and blockers are saved; the recording itself is deleted after transcription. Ask the host to disable Zavi in workspace settings to opt out.',
  enabled_by uuid references auth.users(id),
  enabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_meeting_settings enable row level security;
create policy tenant_meeting_settings_select on tenant_meeting_settings
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy tenant_meeting_settings_active_tenant_restrict
  on tenant_meeting_settings as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create table meeting_bots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null default 'recall',
  provider_bot_id text unique,
  meeting_url text not null,
  status text not null default 'scheduled' check (status in (
    'scheduled','joining','in_call','call_ended','processing','ingested','failed'
  )),
  error text,
  scheduled_date date not null,
  scheduled_for timestamptz not null,
  atoms_count int not null default 0,
  transcript_chars int not null default 0,
  media_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, scheduled_date)
);
create index meeting_bots_tenant_idx on meeting_bots (tenant_id, created_at desc);

alter table meeting_bots enable row level security;
create policy meeting_bots_select on meeting_bots
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy meeting_bots_active_tenant_restrict
  on meeting_bots as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create table meeting_atoms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  bot_id uuid not null references meeting_bots(id) on delete cascade,
  atom_type text not null check (atom_type in (
    'blocker','decision','spec_fact','commitment','policy','capacity_signal'
  )),
  title text not null,
  body text not null default '',
  owner text,
  due_date date,
  expires_at timestamptz,
  confidence text not null default 'medium' check (confidence in ('low','medium','high')),
  memory_class text not null check (memory_class in ('canonical','active_ops','watchlist')),
  status text not null default 'pending_review' check (status in (
    'pending_review','approved','rejected','auto_stored','expired'
  )),
  source_excerpt text not null default '',
  memory_note_id uuid,
  created_at timestamptz not null default now()
);
create index meeting_atoms_tenant_idx on meeting_atoms (tenant_id, created_at desc);
create index meeting_atoms_active_idx on meeting_atoms (tenant_id, status)
  where status in ('auto_stored','pending_review');

alter table meeting_atoms enable row level security;
create policy meeting_atoms_select on meeting_atoms
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy meeting_atoms_active_tenant_restrict
  on meeting_atoms as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  ('notetaker.write_atoms',
   'Write reviewed standup memory atoms into the company brain',
   'approval',
   'memory.write_meeting_atoms')
on conflict (slug) do nothing;

alter table memory_note drop constraint if exists memory_note_source_check;
alter table memory_note add constraint memory_note_source_check check (
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
    'agent_write',
    'gap_distill',
    'episode_distill',
    'external_learning_distill',
    'meeting_distill'
  )
);
