
create table if not exists agent_run_stream_drafts (
  run_id uuid primary key references agent_runs(id) on delete cascade,
  tenant_id uuid not null,
  thread_id uuid,
  agent_slug text not null,
  seq bigint not null default 0,
  text text not null default '',
  status text not null default 'streaming',
  updated_at timestamptz not null default now()
);

alter table agent_run_stream_drafts enable row level security;

create policy agent_run_stream_drafts_member_select on agent_run_stream_drafts
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = agent_run_stream_drafts.tenant_id
        and tu.user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.agent_run_stream_drafts;

update system_config
set blob = jsonb_set(
      coalesce(blob, '{}'::jsonb),
      '{stream_tokens_enabled}',
      'false'::jsonb,
      true
    ),
    updated_at = now()
where id = 1;
