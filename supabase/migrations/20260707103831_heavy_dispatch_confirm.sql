
alter table agent_threads
  add column if not exists heavy_confirm_pending jsonb;

comment on column agent_threads.heavy_confirm_pending is
  'Pending heavy-build confirmation token for the operator->heavy-target gate: {intent_hash, armed_run_id, target, est_credits, armed_at}. Armed on turn 1 (returns pending_confirmation, no enqueue); consumed+cleared on the confirmed turn. NULL = none. See services/agents/heavy-dispatch-pending.ts.';

insert into system_config (id, blob)
  values (1, jsonb_build_object('heavy_dispatch_confirm', true))
on conflict (id) do update
  set blob = coalesce(system_config.blob, '{}'::jsonb)
             || jsonb_build_object('heavy_dispatch_confirm', true),
      updated_at = now();
