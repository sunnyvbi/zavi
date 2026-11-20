
begin;

create table if not exists tenant_channels (
  tenant_id         uuid not null references tenants(id) on delete cascade,
  channel_slug      text not null,

  delivery_mode     text not null default 'advise'
    check (delivery_mode in ('advise', 'produce', 'execute')),

  work_state        text not null default 'idle'
    check (work_state in ('idle', 'running', 'needs_review', 'delivered')),

  priority          int  not null default 100,

  last_run_at       timestamptz,

  credits_30d_cache int  not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, channel_slug)
);

alter table tenant_channels enable row level security;

drop policy if exists tenant_channels_member_select on tenant_channels;
create policy tenant_channels_member_select on tenant_channels
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_channels.tenant_id
    )
  );

drop policy if exists tenant_channels_active_tenant_restrict on tenant_channels;
create policy tenant_channels_active_tenant_restrict
  on tenant_channels as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke all on table tenant_channels from public, anon, authenticated;
grant select on table tenant_channels to authenticated;
grant all on table tenant_channels to service_role;

create or replace function seed_tenant_channels(p_tenant_id uuid, p_slugs text[])
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count int;
begin
  if p_tenant_id is null or p_slugs is null or array_length(p_slugs, 1) is null then
    return 0;
  end if;
  insert into tenant_channels (tenant_id, channel_slug)
  select p_tenant_id, s from unnest(p_slugs) as s
  on conflict (tenant_id, channel_slug) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function record_channel_run(p_tenant_id uuid, p_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant  uuid;
  v_channel text;
  v_status  text;
  v_state   text;
  v_at      timestamptz;
begin
  select tenant_id, channel_slug, status, coalesce(finished_at, started_at, enqueued_at)
    into v_tenant, v_channel, v_status, v_at
  from agent_runs where id = p_run_id;

  if v_tenant is null or v_channel is null then
    return;
  end if;

  if p_tenant_id is distinct from v_tenant then
    raise exception 'record_channel_run: run % belongs to tenant %, not %',
      p_run_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;

  v_state := case
    when v_status in ('queued', 'running') then 'running'
    when v_status = 'success'              then 'delivered'
    else 'needs_review'
  end;

  update tenant_channels
     set work_state  = v_state,
         last_run_at = greatest(coalesce(last_run_at, v_at), v_at),
         updated_at  = now()
   where tenant_id = v_tenant and channel_slug = v_channel;
end $$;

revoke all on function seed_tenant_channels(uuid, text[]) from public, anon, authenticated;
revoke all on function record_channel_run(uuid, uuid)     from public, anon, authenticated;
grant execute on function seed_tenant_channels(uuid, text[]) to service_role;
grant execute on function record_channel_run(uuid, uuid)     to service_role;

commit;

do $$
begin
  raise notice '20260901200000: tenant_channels created (dual RLS: member permissive + active-tenant restrictive; no DML policy; writes via seed_tenant_channels/record_channel_run)';
end $$;
