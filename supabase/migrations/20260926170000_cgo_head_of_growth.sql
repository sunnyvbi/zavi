
begin;

create table if not exists cgo_notes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  run_id           uuid references agent_runs(id) on delete set null,
  kind             text not null check (kind in ('scheduled', 'alarm', 'founder')),
  saw              text[] not null default '{}',
  changed          text[] not null default '{}',
  would_change     text[] not null default '{}',
  need             text[] not null default '{}',
  alarm_keys       text[] not null default '{}',
  next_review_at   timestamptz not null,
  next_review_why  text check (next_review_why is null or char_length(next_review_why) <= 300),
  created_at       timestamptz not null default now(),
  unique (run_id)
);

create index if not exists cgo_notes_tenant_created_idx on cgo_notes (tenant_id, created_at desc);

alter table cgo_notes enable row level security;

create policy cgo_notes_member_select on cgo_notes
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = cgo_notes.tenant_id
    )
  );
create policy cgo_notes_active_tenant_restrict
  on cgo_notes as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

alter table autopilot_goals add column if not exists cgo_undo jsonb;

alter table tenant_channels
  add column if not exists founder_seen_at timestamptz,
  add column if not exists cgo_reason text check (cgo_reason is null or char_length(cgo_reason) <= 300),
  add column if not exists cgo_set_at timestamptz;

create or replace function mark_channel_seen(p_channel_slug text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;
  if not exists (
    select 1 from tenant_users where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;
  update tenant_channels
     set founder_seen_at = now()
   where tenant_id = v_tenant_id
     and channel_slug = p_channel_slug;
end;
$$;

revoke all on function mark_channel_seen(text) from public, anon, authenticated;
grant execute on function mark_channel_seen(text) to authenticated, service_role;

commit;
