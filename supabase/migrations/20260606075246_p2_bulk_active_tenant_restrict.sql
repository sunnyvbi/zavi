
do $$
declare
  t text;
  candidates text[] := array[
    'action_outcomes',
    'agent_clarification_responses',
    'agent_csat_daily',
    'agent_decisions_not_taken',
    'agent_drafts',
    'agent_engagement_signals',
    'agent_feedback',
    'agent_learning_sources',
    'agent_open_actions',
    'agent_prediction_signals',
    'agent_run_events',
    'agent_runs',
    'agent_setup_state',
    'agent_thread_messages',
    'agent_threads',
    'agent_work_items',
    'application_messages',
    'applications',
    'autopilot_action_ledger',
    'autopilot_goals',
    'browser_sessions',
    'code_index_builds',
    'code_index_state',
    'code_symbol_refs',
    'code_symbols',
    'comms_caps',
    'comms_send_log',
    'comms_suppressions',
    'comms_unsubscribes',
    'conductor_runs',
    'decisions',
    'delegation_lineage',
    'dispatch_history',
    'dream_candidates',
    'dream_cycle_runs',
    'dream_cycle_verdicts',
    'email_domain_warmup',
    'email_messages',
    'email_send_counters',
    'email_suppression',
    'email_threads',
    'email_unsub_token',
    'enqueue_rejections',
    'entity_aliases',
    'extracted_artifacts',
    'higgsfield_generate_counters',
    'improvement_attempt',
    'ingested_events',
    'memory_chunk',
    'memory_docs',
    'memory_entity',
    'memory_note',
    'memory_note_entity',
    'memory_relation',
    'outbound_prospects',
    'outbound_sequences',
    'paged_baseline_snapshot',
    'pm_roadmap',
    'praxis_logs',
    'refine_suggestions',
    'repo_profiles',
    'run_artifacts',
    'slack_channel_members',
    'slack_channels',
    'slack_message_index',
    'slack_workspaces',
    'social_connected_accounts',
    'tenant_ad_snapshots',
    'tenant_agent_email_identity',
    'tenant_agent_kill_switch',
    'tenant_agent_provider_overrides',
    'tenant_agent_schedules',
    'tenant_agents',
    'tenant_brief_dispatches',
    'tenant_budget_counters',
    'tenant_budget_override',
    'tenant_buffer_connection',
    'tenant_build_credit_ledger',
    'tenant_build_credits',
    'tenant_commands',
    'tenant_config_audit',
    'tenant_db_catalog',
    'tenant_db_config',
    'tenant_decision_class_overrides',
    'tenant_events',
    'tenant_inbox_domain',
    'tenant_ingest_keys',
    'tenant_local_lane',
    'tenant_mcp_servers',
    'tenant_packs',
    'tenant_resources',
    'tenant_skills',
    'tenant_slack_index_state',
    'tenant_subscriptions',
    'test_cases',
    'thread_event',
    'voice_session_costs',
    'voice_sessions'
  ];
begin
  foreach t in array candidates loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
    ) then
      raise notice 'P2 skip (not a base table): %', t;
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'tenant_id'
    ) then
      raise notice 'P2 skip (no tenant_id column): %', t;
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_active_tenant_restrict', t);
    execute format(
      'create policy %I on public.%I as restrictive for select '
      'using (tenant_id = nullif(auth.jwt() -> ''app_metadata'' ->> ''active_tenant_id'', '''')::uuid)',
      t || '_active_tenant_restrict', t);
  end loop;
end $$;
