
set statement_timeout = 0;
set lock_timeout = '5s';

do $$
declare
  v_sig text;
  v_proc regprocedure;
  v_had_authenticated boolean;
  v_missing text[] := '{}';
begin
  foreach v_sig in array array[
    'public.fundraising_advance_stage(uuid,uuid,text)',
    'public.fundraising_insert_document(uuid,uuid,text,text,text)',
    'public.fundraising_mark_outreach_replied(uuid,text,boolean)',
    'public.fundraising_mark_outreach_sent(uuid,text,text)',
    'public.fundraising_mark_round_requested(uuid)',
    'public.fundraising_set_investor_email(uuid,uuid,text)',
    'public.fundraising_set_outreach_state(uuid,uuid,text)',
    'public.fundraising_set_raise_phase(uuid,text)',
    'public.fundraising_set_review_done(uuid,boolean)',
    'public.fundraising_set_review_state(uuid,text,text)',
    'public.fundraising_set_round_config(uuid,text,text,text,text,text,text,text)',
    'public.fundraising_set_round_stage(uuid,text)',
    'public.fundraising_upsert_investor(uuid,text,text,text,text,text,text,text,text)',
    'public.set_figma_connection(uuid,text,text)',
    'public.set_google_calendar_connection(uuid,text,text)',
    'public.set_posthog_connection(uuid,text,text,text)',
    'public.set_sentry_connection(uuid,text,text)',
    'public.set_social_connection(uuid,text,text,text,text,uuid,text)',
    'public.set_stripe_connection(uuid,text,text,text,text,text,text[])',
    'public.set_supabase_connection(uuid,text,text,text)',
    'public.suppress_decision(uuid,text)'
  ] loop
    v_proc := to_regprocedure(v_sig);
    if v_proc is null then
      v_missing := v_missing || v_sig;
      continue;
    end if;
    execute format('revoke all on function %s from public, anon, authenticated', v_proc);
    execute format('grant execute on function %s to service_role', v_proc);
  end loop;

  foreach v_sig in array array[
    'public._assert_tenant_admin(uuid)',
    'public._assert_tenant_member(uuid)',
    'public._owned_clarify_request(uuid)',
    'public.activate_tenant(text,text,numeric,jsonb)',
    'public.activate_tenant_pack(uuid,text,text)',
    'public.add_agent_pin(text,uuid)',
    'public.add_email_allowlist_entry(text,text)',
    'public.apply_extracted_artifact(uuid)',
    'public.approve_decision(uuid)',
    'public.clear_github_selected_repos(uuid)',
    'public.clear_tenant_autonomy(uuid,text)',
    'public.create_agent_draft(uuid,text,text,text,text,text,text,text,text[],text)',
    'public.delete_agent_schedule(uuid,text)',
    'public.delete_agent_thread(uuid)',
    'public.delete_tenant_command(text)',
    'public.demote_admin_to_member(uuid,text[])',
    'public.disconnect_github(uuid)',
    'public.disconnect_higgsfield(uuid)',
    'public.disconnect_meta_ads(uuid)',
    'public.disconnect_tiktok(uuid)',
    'public.enable_mcp_server(uuid,text,mcp_transport,text,text,text[])',
    'public.enqueue_work_item(uuid,text,text,jsonb,text,integer,timestamp with time zone,text,text,text)',
    'public.fork_agent_template(uuid,text,text,jsonb,text)',
    'public.fundraising_list_investors(uuid)',
    'public.get_agent_fleet_graph()',
    'public.get_agent_thread(text,timestamp with time zone,bigint,integer,uuid)',
    'public.get_diagnosis_provenance(uuid,text)',
    'public.get_tabs_session()',
    'public.get_team_member_detail(uuid)',
    'public.get_tenant_notification_settings()',
    'public.get_user_prefs()',
    'public.link_subject(uuid,uuid,jsonb)',
    'public.list_agent_feedback(text)',
    'public.list_agent_threads(text)',
    'public.list_agent_threads_feed(text,integer,timestamp with time zone)',
    'public.list_agents_for_tenant()',
    'public.list_email_allowlist()',
    'public.list_team_members()',
    'public.list_tenant_commands()',
    'public.mark_agent_seen(text)',
    'public.mark_agent_unread(text)',
    'public.mark_thread_seen(uuid)',
    'public.memory_entity_upsert(uuid,text,text,jsonb)',
    'public.memory_note_delete(uuid,uuid)',
    'public.memory_note_upsert(uuid,uuid,text,text,text,text,text[])',
    'public.memory_relation_upsert(uuid,uuid,uuid,text,numeric,uuid)',
    'public.merge_team_members(uuid,uuid)',
    'public.promote_member_to_admin(uuid)',
    'public.qa_set_test_case_tested(uuid,boolean)',
    'public.reject_decision(uuid)',
    'public.reject_extracted_artifact(uuid)',
    'public.remove_email_allowlist_entry(uuid)',
    'public.revoke_invite(uuid)',
    'public.revoke_member(uuid)',
    'public.save_agent_version(uuid,text,text,jsonb,tenant_agent_status)',
    'public.send_agent_chat_turn(text,text,text,uuid,uuid)',
    'public.set_active_tenant(uuid)',
    'public.set_agent_pins(jsonb)',
    'public.set_github_default_repo(uuid,text)',
    'public.set_github_repo_base_branch(uuid,text,text)',
    'public.set_github_selected_repos(uuid,bigint[])',
    'public.set_mapping_confirmed(uuid,text,jsonb)',
    'public.set_member_agents(uuid,text[])',
    'public.set_operator_decision(uuid,text)',
    'public.set_tabs_session(jsonb,text)',
    'public.set_tenant_autonomy(uuid,text,decision_autonomy)',
    'public.set_tenant_class_caps(uuid,text,numeric,numeric)',
    'public.set_tenant_money_model(uuid,autopilot_money_model)',
    'public.set_tenant_product_url(uuid,jsonb)',
    'public.set_tenant_resource_mode(uuid,text,text)',
    'public.set_tenant_sandbox_keepalive(uuid,boolean)',
    'public.set_user_pref(text,jsonb)',
    'public.submit_ad_snapshot(text,date,date,jsonb,text)',
    'public.submit_tenant_feedback(text,jsonb,text,uuid)',
    'public.trigger_team_discover(text[])',
    'public.update_team_member(uuid,text,text,text)',
    'public.update_tenant_notification_settings(text,text,text)',
    'public.upsert_agent_schedule(uuid,text,text,boolean,jsonb,text)',
    'public.upsert_booking_metric_config(uuid,text,text,text,text,text[],text,text,text,text,text,boolean,text)',
    'public.upsert_clarification_draft(uuid,jsonb)',
    'public.upsert_notification_settings(boolean,boolean,boolean)',
    'public.upsert_tenant_command(text,text,text,text)'
  ] loop
    v_proc := to_regprocedure(v_sig);
    if v_proc is null then
      v_missing := v_missing || v_sig;
      continue;
    end if;
    v_had_authenticated := has_function_privilege('authenticated', v_proc, 'execute');
    execute format('revoke all on function %s from public, anon', v_proc);
    if v_had_authenticated then
      execute format('grant execute on function %s to authenticated', v_proc);
    end if;
    execute format('grant execute on function %s to service_role', v_proc);
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise warning 'revoke_anon_from_definer_rpcs: % signature(s) not found, skipped: %',
      array_length(v_missing, 1), v_missing;
  end if;
end $$;
