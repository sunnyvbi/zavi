
begin;

create table if not exists metric_incidents (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  family                text not null check (family in ('acquisition', 'conversion', 'ads_meta', 'ads_google', 'revenue', 'tracking')),
  status                text not null check (status in ('open', 'worsened', 'recovered')),
  primary_key           text not null check (char_length(primary_key) <= 80),
  severity              numeric not null,
  signals               jsonb not null default '[]'::jsonb,
  opened_on             date not null,
  last_eval_on          date not null,
  normal_streak         int not null default 0,
  recovered_on          date,
  notice_severity       numeric,
  notices               int not null default 0,
  pending_notice        boolean not null default false,
  last_notice_mode      text check (last_notice_mode is null or last_notice_mode in ('shadow', 'on', 'muted')),
  last_message_subject  text check (last_message_subject is null or char_length(last_message_subject) <= 300),
  last_message_text     text check (last_message_text is null or char_length(last_message_text) <= 4000),
  last_channel          text check (last_channel is null or last_channel in ('slack', 'email', 'none', 'failed')),
  wake_run_id           uuid references agent_runs(id) on delete set null,
  wake_status           text check (wake_status is null or char_length(wake_status) <= 64),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists metric_incidents_one_active
  on metric_incidents (tenant_id, family)
  where status <> 'recovered';
create index if not exists metric_incidents_tenant_opened_idx
  on metric_incidents (tenant_id, opened_on desc);

create table if not exists metric_moves (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  metric_id     text not null check (char_length(metric_id) <= 64),
  move_date     date not null,
  direction     text not null check (direction in ('up', 'down')),
  good          boolean not null,
  severity      numeric not null,
  value         numeric,
  typical       numeric,
  created_at    timestamptz not null default now(),
  unique (tenant_id, metric_id, move_date)
);

create table if not exists metric_alert_mutes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  mute_key    text not null check (char_length(mute_key) <= 80),
  muted_by    uuid,
  created_at  timestamptz not null default now(),
  unique (tenant_id, mute_key)
);

alter table metric_incidents enable row level security;
alter table metric_moves enable row level security;
alter table metric_alert_mutes enable row level security;

create policy metric_incidents_member_select on metric_incidents
  for select using (
    exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = metric_incidents.tenant_id)
  );
create policy metric_incidents_active_tenant_restrict on metric_incidents
  as restrictive for select using (tenant_id = (select public.app_active_tenant()));

create policy metric_moves_member_select on metric_moves
  for select using (
    exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = metric_moves.tenant_id)
  );
create policy metric_moves_active_tenant_restrict on metric_moves
  as restrictive for select using (tenant_id = (select public.app_active_tenant()));

create policy metric_alert_mutes_member_select on metric_alert_mutes
  for select using (
    exists (select 1 from tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = metric_alert_mutes.tenant_id)
  );
create policy metric_alert_mutes_active_tenant_restrict on metric_alert_mutes
  as restrictive for select using (tenant_id = (select public.app_active_tenant()));

revoke all on table public.metric_incidents from public, anon;
revoke all on table public.metric_moves from public, anon;
revoke all on table public.metric_alert_mutes from public, anon;
revoke insert, update, delete, truncate, references, trigger on table public.metric_incidents from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.metric_moves from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.metric_alert_mutes from authenticated;

commit;
