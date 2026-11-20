
begin;

alter table tenant_channels
  add column if not exists last_probe_at    timestamptz,
  add column if not exists last_probe_delta jsonb;

comment on column tenant_channels.last_probe_at is
  'When the watch evaluator last ran for this channel. Distinct from last_run_at: a probe is a deterministic read of tenant_metric_snapshots with no model and no agent run, so it advances on days the channel did not run. This is what stops a quiet channel reading as dead in the drawer.';

comment on column tenant_channels.last_probe_delta is
  'Computed verdict of the last probe, render-ready. Shape: {signals:[{key,prev,now,pct}], verdict:"changed"|"unchanged"|"unavailable", reason?:text}. NULL means never probed - the drawer hides the row rather than showing an empty state.';

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

  insert into tenant_channels (tenant_id, channel_slug, work_state, last_run_at)
  values (v_tenant, v_channel, v_state, v_at)
  on conflict (tenant_id, channel_slug) do update
     set work_state  = case
                         when tenant_channels.last_run_at is null
                           or v_at >= tenant_channels.last_run_at
                         then v_state
                         else tenant_channels.work_state
                       end,
         last_run_at = greatest(coalesce(tenant_channels.last_run_at, v_at), v_at),
         updated_at  = now();
end $$;

revoke all on function record_channel_run(uuid, uuid) from public, anon, authenticated;
grant execute on function record_channel_run(uuid, uuid) to service_role;

commit;
