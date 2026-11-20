
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/services/supabase";

declare const TENANT_BRAND: unique symbol;
export type TenantId = string & { readonly [TENANT_BRAND]: true };

export function asTenantId(validated: string): TenantId {
  return validated as TenantId;
}

export type ScopeKind =
  | "tenant_id"
  | "idIsTenantId"
  | "user_id"
  | "global"
  | "staffCrossTenant"
  | "unsupported";

const SAFE_EMBEDDED_RELATIONS = new Set<string>([
  "social_posts.social_publish_attempts",
]);

const REGISTRY: Record<string, ScopeKind> = {
  x_organic_trials: "tenant_id",
  booking_daily_rollup: "tenant_id",
  outcome_rollup: "tenant_id",
  booking_metric_config: "tenant_id",
  utilization_metric_config: "tenant_id",
  reddit_ad_operations: "tenant_id",
  reddit_ad_authority: "tenant_id",
  reddit_ad_monitor_state: "tenant_id",
  tiktok_ad_launches: "tenant_id",
  tiktok_ad_video_uploads: "tenant_id",
  tiktok_launch_claims: "tenant_id",
  ad_pending_tests: "tenant_id",
  email_templates: "tenant_id",
  email_send_outcomes: "tenant_id",
  email_send_refs: "tenant_id",
  email_send_results: "tenant_id",
  email_result_tasks: "tenant_id",
  email_learn_observations: "tenant_id",
  email_learnings: "tenant_id",
  email_learning_seen: "tenant_id",
  email_learning_reads: "tenant_id",
  email_learn_work: "tenant_id",
  email_learn_state: "tenant_id",
  email_planned_sends: "tenant_id",
  email_plan_jobs: "tenant_id",
  email_plan_outbox: "tenant_id",
  email_plan_schedule: "tenant_id",
  email_send_reservations: "tenant_id",
  email_bulk_event_ids: "global",
  email_unsubscribe_marks: "tenant_id",
  system_config: "global",
  tenant_store_bindings: "user_id",
  revenuecat_events: "global",
  app_setting: "global",
  gatekeeper_flags: "global",
  alert_email_dedup: "global",
  customer_email_once: "global",
  cgo_review_watch_state: "global",
  db_connector_pair_limits: "global",
  db_rediscovery_backfill_state: "global",
  ops_alert_outbox: "global",
  team_report_pings: "global",
  platform_worker_secret_fingerprints: "global",
  platform_secrets: "global",
  human_members: "global",
  human_member_handles: "global",
  human_member_pii: "global",
  creator_packages: "global",
  agent_auth_seat_cooldown: "global",
  agent_auth_seat_usage: "global",
  agent_auth_seat_note: "global",
  meta_ad_account_cooldown: "global",
  account_deletions: "global",
  tenants: "idIsTenantId",
  profiles: "user_id",
  admin_growth_signup_location: "user_id",
  admin_growth_activity: "user_id",
  admin_growth_settings: "staffCrossTenant",
  admin_growth_classifications: "staffCrossTenant",
  tenant_users: "tenant_id",
  agent_runs: "tenant_id",
  tenant_agent_kill_switch: "tenant_id",
  agent_feedback: "tenant_id",
  agent_asks: "tenant_id",
  custom_agents: "tenant_id",
  custom_agent_triggers: "tenant_id",
  custom_agent_whatsapp_pending: "tenant_id",
  custom_agent_write_receipts: "tenant_id",
  custom_agent_handoff_joins: "tenant_id",
  custom_agent_reserved_names: "global",
  custom_agent_confirm_tokens: "tenant_id",
  agent_run_events: "tenant_id",
  conductor_runs: "tenant_id",
  extension_consent: "tenant_id",
  extension_screenshots: "tenant_id",
  extension_panel_sessions: "tenant_id",
  extension_browser_ops: "tenant_id",
  extension_auth_codes: "user_id",
  agent_threads: "tenant_id",
  agent_thread_messages: "tenant_id",
  slack_triage_claims: "tenant_id",
  decisions: "tenant_id",
  thread_event: "tenant_id",
  delegation_lineage: "tenant_id",
  ad_set_strategist_reviews: "tenant_id",
  memory_note: "tenant_id",
  memory_chunk: "tenant_id",
  memory_write_log: "tenant_id",
  memory_conflict_pair: "tenant_id",
  memory_forget_request: "tenant_id",
  memory_search_trace: "tenant_id",
  agent_email_recipients: "tenant_id",
  tenant_agent_email_identity: "tenant_id",
  email_threads: "tenant_id",
  email_messages: "tenant_id",
  tenant_db_config: "tenant_id",
  data_access_log: "tenant_id",
  db_access_requests: "tenant_id",
  agent_run_checkpoints: "tenant_id",
  tenant_db_settings: "tenant_id",
  tenant_db_generation: "tenant_id",
  tenant_db_catalog: "tenant_id",
  db_connectors: "tenant_id",
  db_connector_pair_codes: "tenant_id",
  db_connector_requests: "tenant_id",
  db_rediscovery_backfill: "tenant_id",
  db_connector_discovery_outbox: "tenant_id",
  db_connector_offline_notices: "tenant_id",
  mapping_confirmed: "tenant_id",
  creator_briefs: "tenant_id",
  creator_orders: "tenant_id",
  creator_money_events: "tenant_id",
  creator_payout_accounts: "global",
  affiliate_codes: "global",
  affiliate_clicks: "global",
  affiliate_referrals: "global",
  affiliate_payouts: "global",
  affiliate_entries: "global",
  affiliate_reversals: "global",
  affiliate_charges: "global",
  affiliate_refunds: "global",
  affiliate_credit_notes: "global",
  affiliate_disputes: "global",
  affiliate_event_inbox: "global",
  creator_invites: "global",
  creator_invite_status: "global",
  onboarding_email_sequence: "tenant_id",
  onboarding_email_visits: "tenant_id",
  admin_script_runs: "global",
  creator_submissions: "tenant_id",
  creator_disputes: "tenant_id",
  creator_reviews: "tenant_id",
  creator_notifications: "tenant_id",
  creator_publications: "tenant_id",
  run_artifacts: "tenant_id",
  tenant_resources: "tenant_id",
  tenant_sandbox: "tenant_id",
  sites: "tenant_id",
  site_providers: "tenant_id",
  site_design_briefs: "tenant_id",
  email_contacts: "tenant_id",
  email_suppression: "tenant_id",
  email_lists: "tenant_id",
  email_list_versions: "tenant_id",
  email_list_version_contacts: "tenant_id",
  email_bulk_sends: "tenant_id",
  email_card_reservations: "tenant_id",
  email_bulk_send_recipients: "tenant_id",
  email_bulk_abuse_holds: "tenant_id",
  tenant_sending_domain: "tenant_id",
  site_function_state: "tenant_id",
  site_function_deployments: "tenant_id",
  site_function_secrets: "tenant_id",
  site_function_schedules: "tenant_id",
  site_function_runs: "tenant_id",
  site_function_logs: "tenant_id",
  tenant_custom_domains: "tenant_id",
  website_edits: "tenant_id",
  tenant_app_setting: "tenant_id",
  tenant_subscriptions: "tenant_id",
  tenant_credit_balances: "tenant_id",
  engineer_html_preview_artifacts: "tenant_id",
  news_topics: "tenant_id",
  news_findings: "tenant_id",
  news_scan_claims: "tenant_id",
  news_digest_deliveries: "tenant_id",
  material_news_emitted: "tenant_id",
  company_profiles: "tenant_id",
  tenant_fact: "tenant_id",
  channel_actions: "tenant_id",
  channel_action_events: "tenant_id",
  starter_autostart_claims: "tenant_id",
  generative_video_jobs: "tenant_id",
  old_site_rebuilds: "tenant_id",
  channel_metrics: "tenant_id",
  channel_runs: "tenant_id",
  customer_visible_open_channel_actions: "tenant_id",
  customer_visible_pending_decisions: "tenant_id",
  channel_run_claims: "tenant_id",
  request_idempotency: "tenant_id",
  channel_settings: "unsupported",
  tenant_channels: "tenant_id",
  cgo_autopilot_state: "tenant_id",
  cgo_autopilot_audit: "tenant_id",
  tenant_ads_write_caps: "tenant_id",
  ads_wallets: "tenant_id",
  ads_creative_uploads: "tenant_id",
  ads_resource_bindings: "tenant_id",
  ads_resource_binding_details: "tenant_id",
  ads_conversion_sources: "tenant_id",
  ads_wallet_orders: "tenant_id",
  ads_campaign_funding: "tenant_id",
  ads_campaign_reservations: "tenant_id",
  ads_account_bindings: "tenant_id",
  ads_campaign_bindings: "tenant_id",
  ads_provider_accounts: "global",
  ads_account_binding_details: "tenant_id",
  ads_campaign_binding_details: "tenant_id",
  ads_account_selections: "tenant_id",
  ads_wallet_consents: "tenant_id",
  ads_wallet_reservation_details: "tenant_id",
  ads_managed_account_grants: "tenant_id",
  ads_managed_account_choices: "tenant_id",
  ads_account_binding_status: "tenant_id",
  ads_campaign_operations: "tenant_id",
  ads_campaign_lifecycle: "tenant_id",
  ads_campaign_pending_stops: "tenant_id",
  ads_campaign_spend_stability: "tenant_id",
  ads_campaign_final_settlements: "tenant_id",
  ads_campaign_create_requests: "tenant_id",
  ad_budgets: "tenant_id",
  growth_business_policies: "tenant_id",
  growth_experiment_controls: "tenant_id",
  ad_budget_reservations: "tenant_id",
  ad_location_choices: "tenant_id",
  pause_past_guard_claims: "tenant_id",
  marketplace_geo_category_weekly: "tenant_id",
  ad_budget_human_actions: "tenant_id",
  ad_budget_events: "tenant_id",
  ad_campaigns: "tenant_id",
  ad_spend_daily: "tenant_id",
  ad_object_changes: "tenant_id",
  ad_budget_snapshots: "tenant_id",
  ad_budget_shadow_verdicts: "tenant_id",
  cgo_creator_caps: "tenant_id",
  creator_hire_spend: "tenant_id",
  autopilot_goal_changes: "tenant_id",
  tenant_data_notes: "tenant_id",
  tenant_verified_queries: "tenant_id",
  action_outcomes: "tenant_id",
  ad_budget_plan: "tenant_id",
  autopilot_goals: "tenant_id",
  growth_plan: "tenant_id",
  tenant_metric_snapshots: "tenant_id",
  cgo_notes: "tenant_id",
  cgo_wake_skips: "tenant_id",
  metric_incidents: "tenant_id",
  metric_moves: "tenant_id",
  metric_alert_mutes: "tenant_id",
  cgo_questions: "tenant_id",
  cgo_ad_holds: "tenant_id",
  cgo_hypotheses: "tenant_id",
  live_stunt_snapshots: "tenant_id",
  live_stunt_days: "tenant_id",
  live_source_hourly: "tenant_id",
  live_source_push: "tenant_id",
  tenant_brand_kits: "tenant_id",
  seo_audit_snapshots: "tenant_id",
  site_seo_audits: "tenant_id",
  site_page_views: "tenant_id",
  site_comment_threads: "tenant_id",
  site_comments: "tenant_id",
  site_logo_previews: "tenant_id",
  site_preview_snapshots: "tenant_id",
  geo_prompts: "tenant_id",
  geo_prompt_sweeps: "tenant_id",
  geo_prompt_responses: "tenant_id",
  geo_crawler_ingest_tokens: "tenant_id",
  geo_crawler_hits_daily: "tenant_id",
  geo_robots_observations: "tenant_id",
  growth_intake_research: "tenant_id",
  growth_strategy_delivery: "tenant_id",
  telegram_chats: "tenant_id",
  brief_applications: "tenant_id",
  engagements: "tenant_id",
  engagement_messages: "tenant_id",
  creator_threads: "tenant_id",
  creator_thread_messages: "tenant_id",
  creator_invite_messages: "tenant_id",
  creator_offers: "tenant_id",
  creator_library_assets: "tenant_id",
  discord_guilds: "tenant_id",
  whatsapp_threads: "tenant_id",
  imessage_threads: "tenant_id",
  tenant_mcp_servers: "tenant_id",
  tenant_personalization: "tenant_id",
  tenant_personalization_history: "tenant_id",
  tenant_document: "tenant_id",
  tenant_rules: "tenant_id",
  tenant_rule_settings: "tenant_id",
  team_note_offers: "tenant_id",
  team_note_judge_claims: "tenant_id",
  team_reports: "tenant_id",
  team_note_prefs: "tenant_id",
  tenant_feedback: "tenant_id",
  team_note_judgements: "tenant_id",
  tenant_credit_ledger: "tenant_id",
  agent_run_side_costs: "tenant_id",
  tool_charges: "tenant_id",
  tenant_first_run_progress: "tenant_id",
  connector_metadata: "tenant_id",
  connector_events: "tenant_id",
  social_posts: "tenant_id",
  social_post_metric_snapshots: "tenant_id",
  social_account_snapshots: "tenant_id",
  social_profile_check_dismissals: "tenant_id",
  reddit_mentions: "tenant_id",
  reddit_threads: "tenant_id",
  reddit_comments: "tenant_id",
  channel_mention_alerts_sent: "tenant_id",
  shared_pages: "tenant_id",
  tiktok_scheduled_posts: "tenant_id",
  start_cards: "global",
  start_card_budget: "global",
  start_card_email_queue: "global",
  start_card_reports: "global",
  seed_runs: "global",
  seed_run_items: "global",
  seed_suppressions: "global",
  seed_notices: "global",
  vendor_usage: "global",
  vendor_usage_alerts: "global",
  onboarding_scans: "global",
  tenant_onboarding_memory: "tenant_id",
  enrichment_audit: "global",
};

export function scopeKind(table: string): ScopeKind {
  return REGISTRY[table] ?? "unsupported";
}

function scopeColumn(table: string): string {
  const kind = scopeKind(table);
  switch (kind) {
    case "tenant_id":
      return "tenant_id";
    case "idIsTenantId":
      return "id";
    case "user_id":
      throw new Error(
        `tenantClient: '${table}' is user-scoped (user_id), not tenant-scoped — use a user-scoped query path, not tenantClient.`,
      );
    case "global":
      throw new Error(
        `tenantClient: '${table}' is a global table — use globalClient().from('${table}').`,
      );
    case "staffCrossTenant":
      throw new Error(
        `tenantClient: '${table}' is staff-cross-tenant — use staffCrossTenantClient(reason).from('${table}').`,
      );
    case "unsupported":
    default:
      throw new Error(
        `tenantClient: table '${table}' is not classified in the scope registry (tenant-client.ts). Add it with its ScopeKind before using it through tenantClient.`,
      );
  }
}

type SelectOpts = { head?: boolean; count?: "exact" | "planned" | "estimated" };

export type TenantScopedTable = {
  select: (columns?: string, opts?: SelectOpts) => ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;
  insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => ReturnType<ReturnType<SupabaseClient["from"]>["insert"]>;
  update: (values: Record<string, unknown>) => ReturnType<ReturnType<SupabaseClient["from"]>["update"]>;
  delete: () => ReturnType<ReturnType<SupabaseClient["from"]>["delete"]>;
  upsert: (
    rows: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) => ReturnType<ReturnType<SupabaseClient["from"]>["upsert"]>;
};

export type TenantClient = { from: (table: string) => TenantScopedTable };

function assertNoForeignScope(
  table: string,
  col: string,
  row: Record<string, unknown>,
  tid: string,
): void {
  const existing = row[col];
  if (existing !== undefined && existing !== null && existing !== tid) {
    throw new Error(
      `tenantClient: row for '${table}' carries ${col}=${String(existing)} which differs from the client scope ${tid} — refusing to silently overwrite (cross-tenant write attempt).`,
    );
  }
}

function isEmbeddedSelect(columns: string | undefined): boolean {
  return !!columns && /[A-Za-z0-9_]+\s*[!(]/.test(columns);
}

function makeScopedTable(sb: SupabaseClient, table: string, tid: string): TenantScopedTable {
  const kind = scopeKind(table);
  const col = scopeColumn(table);

  const canWriteRows = kind === "tenant_id";

  return {
    select(columns, opts) {
      if (isEmbeddedSelect(columns)) {
        const relations = Array.from((columns ?? "").matchAll(/([A-Za-z0-9_]+)\s*[!(]/g));
        const rel = relations[0]?.[1];
        if (relations.length !== 1 || !rel || !SAFE_EMBEDDED_RELATIONS.has(`${table}.${rel}`)) {
          throw new Error(
            `tenantClient: embedded select '${rel ?? "?"}' on '${table}' is not tenant-verified — do a two-step query or register the relation in SAFE_EMBEDDED_RELATIONS after review.`,
          );
        }
      }
      return (sb.from(table).select as (c?: string, o?: SelectOpts) => any)(columns, opts).eq(col, tid);
    },

    insert(rows) {
      if (!canWriteRows) {
        throw new Error(`tenantClient: insert into '${table}' (${kind}) is not a tenant-scoped operation.`);
      }
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        assertNoForeignScope(table, col, r, tid);
        r[col] = tid;
      }
      return sb.from(table).insert(arr);
    },

    update(values) {
      assertNoForeignScope(table, col, values, tid);
      return sb.from(table).update(values).eq(col, tid);
    },

    delete() {
      return sb.from(table).delete().eq(col, tid);
    },

    upsert(rows, opts) {
      if (!canWriteRows) {
        throw new Error(`tenantClient: upsert into '${table}' (${kind}) is not a tenant-scoped operation.`);
      }
      const targets = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!targets.includes(col)) {
        throw new Error(
          `tenantClient: upsert on tenant table '${table}' requires onConflict to include '${col}' (got ${opts?.onConflict ?? "none"}) — otherwise the update path is un-scoped across tenants.`,
        );
      }
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        assertNoForeignScope(table, col, r, tid);
        r[col] = tid;
      }
      return sb.from(table).upsert(arr, opts);
    },
  };
}

export function tenantClient(tid: TenantId): TenantClient {
  const sb = serviceClient();
  return { from: (table: string) => makeScopedTable(sb, table, tid) };
}

export function globalClient(): { from: (table: string) => ReturnType<SupabaseClient["from"]> } {
  const sb = serviceClient();
  return {
    from(table: string) {
      if (scopeKind(table) !== "global") {
        throw new Error(`globalClient: '${table}' is not a global table (kind=${scopeKind(table)}).`);
      }
      return sb.from(table);
    },
  };
}

export function tenantStorage(tid: TenantId): SupabaseClient["storage"] {
  if (!tid) {
    throw new Error("tenantStorage: a guarded TenantId is required (mint via asTenantId).");
  }
  return serviceClient().storage;
}

export function humanApplicantStorage(authUserId: string): SupabaseClient["storage"] {
  if (!authUserId || authUserId.trim().length === 0) {
    throw new Error("humanApplicantStorage: the applicant's verified auth user id is required.");
  }
  return serviceClient().storage;
}

export function creatorInboxClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("creatorInboxClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function creatorBoardClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("creatorBoardClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function creatorAreaClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("creatorAreaClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function staffCrossTenantClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("staffCrossTenantClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function storeBillingClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("storeBillingClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function oauthCallbackClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("oauthCallbackClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function publicHostClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("publicHostClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function fleetSweepClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("fleetSweepClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function redditChannelClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("redditChannelClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function signupLocationClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) throw new Error("signupLocationClient: reason required");
  return serviceClient();
}

export function selfAccountClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("selfAccountClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export async function readShopifyConfirmationUserEmail(userId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("readShopifyConfirmationUserEmail: valid user id required");
  }
  const { data, error } = await serviceClient().auth.admin.getUserById(userId);
  if (error) throw error;
  return data.user?.email ?? null;
}

export function extensionAuthCodeClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("extensionAuthCodeClient: a substantive reason string is required.");
  }
  return serviceClient();
}

const RPC_TENANT_ARG: Record<string, string> = {
  set_composio_app_connection: "p_tenant_id",
  advance_growth_strategy: "p_tenant_id",
  reset_growth_strategy_delivery: "p_tenant_id",
  memory_fact_neighbors: "p_tenant_id",
  memory_undo_update: "p_tenant_id",
  memory_undo_forget: "p_tenant_id",
  memory_keep_conflict_value: "p_tenant_id",
  apply_dream_verdict: "p_tenant_id",
  ads_legacy_account_binding: "p_tenant_id",
  ads_verify_account_binding: "p_tenant_id",
  ads_bind_campaign: "p_tenant_id",
  ads_select_account_binding: "p_tenant_id",
  ads_register_customer_account: "p_tenant_id",
  ads_release_customer_account_claim: "p_tenant_id",
  ads_save_chatgpt_customer_account: "p_tenant_id",
  ads_use_managed_account: "p_tenant_id",
  ads_set_wallet_consent: "p_tenant_id",
  ads_disable_account_binding: "p_tenant_id",
  ads_enable_account_binding: "p_tenant_id",
  ads_claim_campaign_operation: "p_tenant_id",
  ads_observe_linkedin_spend: "p_tenant_id",
  ads_release_unsent_linkedin_launch: "p_tenant_id",
  ads_claim_campaign_account: "p_tenant_id",
  ads_wallet_reserve_bound: "p_tenant_id",
  ads_reserve_linkedin_launch: "p_tenant_id",
  ads_wallet_reserve_chatgpt_daily_bound: "p_tenant_id",
  ads_wallet_settle_bound: "p_tenant_id",
  ads_wallet_finalize_bound: "p_tenant_id",
  ads_wallet_reserve: "p_tenant_id",
  ads_wallet_reserve_daily: "p_tenant_id",
  ads_wallet_settle_spend: "p_tenant_id",
  ads_wallet_finalize_campaign: "p_tenant_id",
  ads_wallet_claim_refill: "p_tenant_id",
  ads_wallet_claim_shortfall: "p_tenant_id",
  resolve_slack_approver: "p_tenant_id",
  reserve_ad_spend: "p_tenant_id",
  settle_ad_spend: "p_tenant_id",
  release_pending_test_hold: "p_tenant_id",
  save_reddit_ad_authority: "p_tenant_id",
  release_ad_spend_for_object: "p_tenant_id",
  release_ad_spend_holds: "p_tenant_id",
  ad_object_hold_usd: "p_tenant_id",
  create_ad_budget: "p_tenant_id",
  save_growth_business_policy: "p_tenant_id",
  approve_growth_business_controls: "p_tenant_id",
  register_growth_experiment: "p_tenant_id",
  record_growth_experiment_check: "p_tenant_id",
  arm_growth_test_stop: "p_tenant_id",
  update_ad_budget: "p_tenant_id",
  stop_ad_budget: "p_tenant_id",
  log_ad_budget_human_action: "p_tenant_id",
  record_ad_budget_actual: "p_tenant_id",
  record_ad_budget_partial_actual: "p_tenant_id",
  record_ad_budget_partial_actual_v2: "p_tenant_id",
  clear_ad_budget_read_failed_platforms: "p_tenant_id",
  note_chatgpt_workspace_hold: "p_tenant_id",
  revoke_chatgpt_autopilot: "p_tenant_id",
  release_ad_budget_alarm: "p_tenant_id",
  start_ad_budget_month: "p_tenant_id",
  claim_ad_budget_month_note: "p_tenant_id",
  release_ad_budget_month_note: "p_tenant_id",
  ad_budget_month_view: "p_tenant_id",
  ad_month_token: "p_tenant_id",
  approve_ad_raise_with_budget: "p_tenant_id",
  record_ad_ledger_read: "p_tenant_id",
  record_ad_object_changes: "p_tenant_id",
  record_ad_budget_snapshot: "p_tenant_id",
  ad_budget_shadow_context: "p_tenant_id",
  record_ad_budget_shadow_verdict: "p_tenant_id",
  rebase_ad_spend_for_object: "p_tenant_id",
  claim_ad_budget_brake: "p_tenant_id",
  release_ad_budget_brake: "p_tenant_id",
  release_idle_ad_holds: "p_tenant_id",
  shrink_underdelivering_ad_holds: "p_tenant_id",
  sync_ad_holds_to_live: "p_tenant_id",
  ad_budget_read_start: "p_tenant_id",
  note_ad_spend_object: "p_tenant_id",
  note_ad_spend_ref: "p_tenant_id",
  resolve_unknown_ad_hold: "p_tenant_id",
  resolve_inflight_ad_hold: "p_tenant_id",
  reserve_creator_hire: "p_tenant_id",
  settle_creator_hire: "p_tenant_id",
  refund_creator_hire: "p_tenant_id",
  record_cgo_creator_caps: "p_tenant_id",
  write_autopilot_goal: "p_tenant_id",
  mint_oauth_state: "p_tenant_id",
  refresh_tiktok_connection: "p_tenant_id",
  set_connector_ad_accounts: "p_tenant_id",
  set_connector_account_geo: "p_tenant_id",
  seed_tenant_channels: "p_tenant_id",
  record_channel_run: "p_tenant_id",
  channel_credits_30d: "p_tenant_id",
  stamp_channel_run: "p_tenant_id",
  retire_growth_plan: "p_tenant_id",
  grant_promo_credits: "p_tenant_id",
  grant_extension_consent: "p_tenant_id",
  revoke_extension_consent: "p_tenant_id",
  claim_extension_op: "p_tenant_id",
  complete_extension_op: "p_tenant_id",
  set_channel_autorun: "p_tenant_id",
  set_chatgpt_autopilot: "p_tenant_id",
  set_cgo_autopilot: "p_tenant_id",
  set_channel_monthly_budget: "p_tenant_id",
  set_channel_in_plan: "p_tenant_id",
  close_dropped_channel_run_cards: "p_tenant_id",
  set_tenant_fact: "p_tenant_id",
  project_tenant_fact: "p_tenant_id",
  set_tenant_company_domain_system: "p_tenant_id",
  channel_budget_allows: "p_tenant_id",
  claim_channel_run: "p_tenant_id",
  settle_channel_run_claim: "p_tenant_id",
  release_channel_run_claim: "p_tenant_id",
  geo_open_prompt_sweep: "p_tenant_id",
  geo_rotate_crawler_ingest_token: "p_tenant_id",
  geo_record_crawler_hits: "p_tenant_id",
  archive_decision: "p_tenant_id",
  snooze_decision: "p_tenant_id",
  emit_decision: "p_tenant_id",
  edit_decision_body_if_proposed: "p_tenant_id",
  drain_agent_run_steers: "p_tenant_id",
  mark_agent_run_steers_drained: "p_tenant_id",
  fundraising_set_review_done: "p_tenant_id",
  claim_news_scan_day: "p_tenant_id",
  claim_news_digest_send: "p_tenant_id",
  mark_news_digest_sent: "p_tenant_id",
  refresh_connector_secrets: "p_tenant_id",
  create_telegram_link_token: "p_tenant_id",
  live_telegram_link_token: "p_tenant_id",
  search_human_members: "p_tenant_id",
  create_discord_link_token: "p_tenant_id",
  live_discord_link_token: "p_tenant_id",
  unset_telegram_connection: "p_tenant_id",
  unset_discord_connection_for_tenant: "p_tenant_id",
  unset_teams_connection: "p_tenant_id",
  create_whatsapp_link_token: "p_tenant_id",
  live_whatsapp_link_token: "p_tenant_id",
  confirm_whatsapp_bind: "p_tenant_id",
  unset_whatsapp_connection: "p_tenant_id",
  unset_whatsapp_thread: "p_tenant_id",
  create_imessage_link_token: "p_tenant_id",
  live_imessage_link_token: "p_tenant_id",
  confirm_imessage_bind: "p_tenant_id",
  unset_imessage_connection: "p_tenant_id",
  unset_imessage_thread: "p_tenant_id",
  set_posthog_connection: "p_tenant_id",
  set_sentry_connection: "p_tenant_id",
  set_figma_connection: "p_tenant_id",
  set_supabase_connection: "p_tenant_id",
  claim_startup_seat: "p_tenant_id",
  attach_startup_claim_payment: "p_tenant_id",
  set_apple_ads_connection: "p_tenant_id",
  set_sendgrid_connection: "p_tenant_id",
  social_post_cancel: "p_tenant_id",
  social_post_reschedule: "p_tenant_id",
  set_tenant_personalization: "p_tenant_id",
  team_note_can_offer: "p_tenant_id",
  team_note_claim_judgement: "p_tenant_id",
  team_note_offer: "p_tenant_id",
  team_note_mark_shown: "p_tenant_id",
  team_note_send: "p_tenant_id",
  team_note_dismiss: "p_tenant_id",
  team_note_mark_opened: "p_tenant_id",
  team_note_set_suggestions: "p_tenant_id",
  team_note_can_offer_v2: "p_tenant_id",
  team_note_claim_judgement_v2: "p_tenant_id",
  team_note_offer_v2: "p_tenant_id",
  team_note_promote_v2: "p_tenant_id",
  team_note_mark_shown_v2: "p_tenant_id",
  team_note_record_judgement_v2: "p_tenant_id",
  rule_add: "p_tenant_id",
  rule_activate: "p_tenant_id",
  rule_edit: "p_tenant_id",
  rule_dismiss: "p_tenant_id",
  rule_delete: "p_tenant_id",
  rule_delete_all: "p_tenant_id",
  rule_set_suggestions_paused: "p_tenant_id",
  rule_set_ad_guard: "p_tenant_id",
  rule_list: "p_tenant_id",
  rule_propose: "p_tenant_id",
  claim_growth_intake_research: "p_tenant_id",
  search_creators: "p_tenant_id",
  consume_metered_read_or_reject: "p_tenant_id",
  store_instagram_snapshots: "p_tenant_id",
  release_metered_read: "p_tenant_id",
  update_x_organic_trial: "p_tenant_id",
  record_channel_run_actions: "p_tenant_id",
  set_channel_action: "p_tenant_id",
  set_channel_action_steps: "p_tenant_id",
  set_channel_action_publish_on: "p_tenant_id",
  revise_pending_ad_action: "p_tenant_id",
  set_staged_post_scheduled_at: "p_tenant_id",
  mark_channel_action_redone: "p_tenant_id",
  displace_channel_actions: "p_tenant_id",
  hold_paced_channel_actions: "p_tenant_id",
  release_paced_channel_actions: "p_tenant_id",
  get_channel_settings: "p_tenant_id",
  set_channel_settings: "p_tenant_id",
  record_channel_exec_action: "p_tenant_id",
  prepare_channel_campaign_action: "p_tenant_id",
  approve_channel_action: "p_tenant_id",
  set_approval_envelope: "p_tenant_id",
  claim_approval_envelope: "p_tenant_id",
  settle_channel_action_exec: "p_tenant_id",
  record_channel_action_exec_progress: "p_tenant_id",
  set_site_pr_waiting: "p_tenant_id",
  reconcile_channel_action_exec: "p_tenant_id",
  approve_email_campaign_send_as_cgo: "p_tenant_id",
  email_card_for_test: "p_tenant_id",
  record_email_test_send: "p_tenant_id",
  email_card_view_state: "p_tenant_id",
  approve_email_card: "p_tenant_id",
  approve_email_card_seen: "p_tenant_id",
  email_send_paused: "p_tenant_id",
  set_email_pause: "p_tenant_id",
  email_bulk_stop_send: "p_tenant_id",
  email_bulk_close_held_send: "p_tenant_id",
  email_card_send_facts: "p_tenant_id",
  replace_email_card: "p_tenant_id",
  rebind_email_planned_card: "p_tenant_id",
  edit_email_card_variant: "p_tenant_id",
  claim_email_send_outcome: "p_tenant_id",
  claim_email_send_outcome_tell: "p_tenant_id",
  release_email_send_outcome: "p_tenant_id",
  keep_email_send_outcome_line: "p_tenant_id",
  set_email_test_list: "p_tenant_id",
  list_email_learnings: "p_tenant_id",
  list_dismissed_email_learnings: "p_tenant_id",
  set_email_learning: "p_tenant_id",
  mark_email_learnings_seen: "p_tenant_id",
  record_email_learn_observations: "p_tenant_id",
  email_learn_inputs: "p_tenant_id",
  apply_email_learn_recompute: "p_tenant_id",
  record_email_learn_sources: "p_tenant_id",
  request_email_learn_seed: "p_tenant_id",
  retry_email_learn_seed: "p_tenant_id",
  complete_email_learn_work: "p_tenant_id",
  extend_email_learn_lease: "p_tenant_id",
  record_email_learning_read: "p_tenant_id",
  get_email_learning_read: "p_tenant_id",
  record_email_send_ref: "p_tenant_id",
  mark_email_send_ref_not_sent: "p_tenant_id",
  start_email_send_result: "p_tenant_id",
  complete_email_result_task: "p_tenant_id",
  mark_email_results_told: "p_tenant_id",
  email_unsubscribe_and_count: "p_tenant_id",
  list_email_suppressions: "p_tenant_id",
  add_email_suppression: "p_tenant_id",
  reserve_email_card: "p_tenant_id",
  release_email_card_reservation: "p_tenant_id",
  settle_email_card_reservation: "p_tenant_id",
  plan_email_send: "p_tenant_id",
  move_email_planned_send: "p_tenant_id",
  change_email_planned_angle: "p_tenant_id",
  skip_email_planned_send: "p_tenant_id",
  draft_email_planned_now: "p_tenant_id",
  schedule_email_planned_send: "p_tenant_id",
  withdraw_email_planned_send: "p_tenant_id",
  begin_email_plan_draft: "p_tenant_id",
  block_email_plan_draft: "p_tenant_id",
  email_plan_run_context: "p_tenant_id",
  attach_email_planned_card: "p_tenant_id",
  discard_email_planned_card: "p_tenant_id",
  email_plan_deadline_state: "p_tenant_id",
  fire_email_planned_send: "p_tenant_id",
  email_plan_unattended_ok: "p_tenant_id",
  complete_email_plan_job: "p_tenant_id",
  mark_email_plan_outbox_sent: "p_tenant_id",
  set_email_plan_schedule: "p_tenant_id",
  finish_email_plan_schedule: "p_tenant_id",
  list_email_planned_sends: "p_tenant_id",
  confirm_email_not_sent: "p_tenant_id",
  email_planned_for_card: "p_tenant_id",
  email_planned_send_row: "p_tenant_id",
  email_list_sent_recently: "p_tenant_id",
  email_list_version_freeze_count: "p_tenant_id",
  set_channel_action_video_media: "p_tenant_id",
  stamp_channel_action_exec_verdict: "p_tenant_id",
  enqueue_ops_alert: "p_tenant_id",
  enqueue_ops_alert_windowed: "p_tenant_id",
  stamp_channel_action_target_keys: "p_tenant_id",
  chain_channel_action_repeat: "p_tenant_id",
  supersede_channel_actions_by_direct_ask: "p_tenant_id",
  retire_stale_budget_proposals: "p_tenant_id",
  retire_cleared_geo_cards: "p_tenant_id",
  charge_media_credits: "p_tenant_id",
  charge_media_credits_batch: "p_tenant_id",
  media_credits_affordable: "p_tenant_id",
  claim_starter_autostart: "p_tenant_id",
  claim_mention_alert_send: "p_tenant_id",
  mark_mention_alert_sent: "p_tenant_id",
  continue_paused_build: "p_tenant_id",
  continue_paused_build_with_site: "p_tenant_id",
  claim_site_setup_retry: "p_tenant_id",
  site_claim_stranded: "p_tenant_id",
  site_claim_failed: "p_tenant_id",
  merge_website_edit: "p_tenant_id",
  claim_old_site_rebuild: "p_tenant_id",
  settle_old_site_rebuild: "p_tenant_id",
  release_old_site_rebuild: "p_tenant_id",
  stamp_custom_agent_run: "p_tenant_id",
  set_channel_in_plan_by_cgo: "p_tenant_id",
  close_channel_actions_on_cgo_pause: "p_tenant_id",
  propose_next_autopilot_goal: "p_tenant_id",
  update_goal_progress: "p_tenant_id",
  record_custom_agent_outcome: "p_tenant_id",
  custom_agent_handoff_register: "p_tenant_id",
  custom_agent_handoff_park: "p_tenant_id",
  custom_agent_handoff_claim: "p_tenant_id",
  custom_agent_handoff_cancel: "p_tenant_id",
  custom_agent_handoff_settle: "p_tenant_id",
  create_custom_agent: "p_tenant_id",
  update_custom_agent: "p_tenant_id",
  pause_channel_by_cgo: "p_tenant_id",
  answer_hypothesis_question: "p_tenant_id",
  undo_hypothesis_answer: "p_tenant_id",
  set_hypothesis_plan_kept: "p_tenant_id",
  set_founder_constraint: "p_tenant_id",
  set_constraint_agreed: "p_tenant_id",
  switch_plan_constraint_to_hypothesis: "p_tenant_id",
  unsnooze_decision: "p_tenant_id",
  ingest_email_message: "p_tenant_id",
  member_user_id_by_email: "p_tenant_id",
  resolve_shopify_app_member: "p_tenant_id",
  link_shopify_app_member: "p_tenant_id",
  shopify_app_member_link_available: "p_tenant_id",
  resolve_shopify_app_member_link: "p_tenant_id",
  delete_shopify_app_member_links: "p_tenant_id",
  is_tenant_member_email: "p_tenant_id",
  disabled_member_emails: "p_tenant_id",
  claim_cgo_pause: "p_tenant_id",
  refund_autopilot_run: "p_tenant_id",
  live_stunt_review_apply: "p_tenant_id",
  live_stunt_draft_upsert: "p_tenant_id",
  live_source_replace: "p_tenant_id",
  request_app_database: "p_tenant_id",
  set_managed_operator_db_connection: "p_tenant_id",
  set_mapping_confirmed_by_zavi: "p_tenant_id",
  carry_forward_mapping_confirmation: "p_tenant_id",
  confirm_booking_outcome_fields: "p_tenant_id",
  confirm_utilization_metric_config: "p_tenant_id",
  set_db_visibility: "p_tenant_id",
  set_db_privacy: "p_tenant_id",
  disconnect_operator_db: "p_tenant_id",
  tenant_admin_emails: "p_tenant_id",
  claim_db_access_request: "p_tenant_id",
  create_db_connector_pair_code: "p_tenant_id",
  redeem_db_connector_pair_code: "p_tenant_id",
  touch_db_connector: "p_tenant_id",
  set_db_connector_dialect: "p_tenant_id",
  enqueue_db_connector_request: "p_tenant_id",
  claim_db_connector_request: "p_tenant_id",
  complete_db_connector_request: "p_tenant_id",
  take_db_connector_result: "p_tenant_id",
  cancel_db_connector_request: "p_tenant_id",
  claim_db_connector_offline_notice: "p_tenant_id",
  ack_db_connector_offline_notice: "p_tenant_id",
  acquire_db_connector_poll: "p_tenant_id",
  release_db_connector_poll: "p_tenant_id",
  ack_db_connector_discovery: "p_tenant_id",
  remove_db_connector: "p_tenant_id",
  reserve_data_access: "p_tenant_id",
  finalize_data_access: "p_tenant_id",
  set_tenant_custom_domain: "p_tenant_id",
  add_run_side_cost: "p_tenant_id",
  record_late_tool_charge: "p_tenant_id",
  refund_tool_charge: "p_tenant_id",
  refund_setup_draft_settle: "p_tenant_id",
  site_get_or_create_for_run: "p_tenant_id",
  site_release_search: "p_tenant_id",
  site_hold_search: "p_tenant_id",
  site_queue_change: "p_tenant_id",
  site_claim_queued_change: "p_tenant_id",
  site_settle_queued_change: "p_tenant_id",
  site_discard_queued_change: "p_tenant_id",
  site_drop_stopped_queued_changes: "p_tenant_id",
  claim_brief_journey_fix: "p_tenant_id",
  claim_brief_journey_fix_status: "p_tenant_id",
  release_brief_journey_fix: "p_tenant_id",
  claim_site_vision_fix_status: "p_tenant_id",
  claim_done_for_you_settle: "p_tenant_id",
  claim_done_for_you_dispatch: "p_tenant_id",
  release_site_vision_fix: "p_tenant_id",
  site_update: "p_tenant_id",
  site_set_github_export: "p_tenant_id",
  site_transition: "p_tenant_id",
  site_settle_stopped: "p_tenant_id",
  site_activate_if_desired: "p_tenant_id",
  site_provider_claim: "p_tenant_id",
  site_provider_set: "p_tenant_id",
  site_provider_schedule_delete: "p_tenant_id",
  site_provider_cancel_delete: "p_tenant_id",
  site_provider_begin_delete: "p_tenant_id",
  site_set_name: "p_tenant_id",
  site_publish_begin: "p_tenant_id",
  site_publish_lease: "p_tenant_id",
  site_publish_release: "p_tenant_id",
  claim_site_preview_lease: "p_tenant_id",
  release_site_preview_lease: "p_tenant_id",
  site_preview_lease_held: "p_tenant_id",
  take_inline_edit_call: "p_tenant_id",
  site_mark_projected: "p_tenant_id",
  site_note_projection_drift: "p_tenant_id",
  site_mark_host_projected: "p_tenant_id",
  delete_site_secrets: "p_tenant_id",
  site_backend_init_static: "p_tenant_id",
  site_backend_place: "p_tenant_id",
  site_backend_release: "p_tenant_id",
  site_host_bump: "p_tenant_id",
  site_backend_dedicate_static: "p_tenant_id",
  site_graduation_request: "p_tenant_id",
  site_graduation_get: "p_tenant_id",
  site_graduation_claim: "p_tenant_id",
  site_graduation_advance: "p_tenant_id",
  site_graduation_switch: "p_tenant_id",
  site_member_role_audit_record: "p_tenant_id",
  site_kernel_register: "p_tenant_id",
  site_kernel_ready: "p_tenant_id",
  site_kernel_retire: "p_tenant_id",
  site_kernel_ref: "p_tenant_id",
  site_fn_secret_set: "p_tenant_id",
  site_fn_secret_delete: "p_tenant_id",
  site_fn_secret_list: "p_tenant_id",
  site_fn_secret_values: "p_tenant_id",
  site_fn_stage: "p_tenant_id",
  site_fn_activate: "p_tenant_id",
  site_fn_set_status: "p_tenant_id",
  site_fn_schedule_set_enabled: "p_tenant_id",
  site_fn_overview: "p_tenant_id",
  site_fn_runs_list: "p_tenant_id",
  site_fn_logs_list: "p_tenant_id",
  site_test_site_create: "p_tenant_id",
  site_test_site_get: "p_tenant_id",
  site_test_site_activate: "p_tenant_id",
  site_test_site_destroy_begin: "p_tenant_id",
  site_test_site_destroyed: "p_tenant_id",
  site_test_site_failed: "p_tenant_id",
  site_kernel_provision_claim: "p_tenant_id",
  site_kernel_provision_advance: "p_tenant_id",
  site_kernel_attach: "p_tenant_id",
  site_backend_dedicate_static_reserve: "p_tenant_id",
  email_bulk_block_reason: "p_tenant_id",
  email_list_import_version: "p_tenant_id",
  email_list_record_consent: "p_tenant_id",
  email_list_summaries: "p_tenant_id",
  email_list_archived_summaries: "p_tenant_id",
  email_list_unarchive: "p_tenant_id",
  email_list_contacts_page: "p_tenant_id",
  email_contacts_people: "p_tenant_id",
  email_contacts_existing_count: "p_tenant_id",
  email_list_version_emails: "p_tenant_id",
  email_contact_erase: "p_tenant_id",
  email_bulk_freeze_send: "p_tenant_id",
  email_bulk_claim_next: "p_tenant_id",
  email_bulk_settle_recipient: "p_tenant_id",
  email_bulk_mark_stale_unknown: "p_tenant_id",
  email_bulk_settle_send: "p_tenant_id",
  email_bulk_record_feedback: "p_tenant_id",
  email_bulk_skip_if_blocked: "p_tenant_id",
  email_bulk_requeue_claimed: "p_tenant_id",
  email_bulk_abuse_switch_off: "p_tenant_id",
  email_bulk_clear_abuse_hold: "p_tenant_id",
  email_bulk_resume_send: "p_tenant_id",
  tenant_sending_domain_check: "p_tenant_id",
  tenant_sending_domain_release: "p_tenant_id",
  tenant_sending_domain_upsert_pending: "p_tenant_id",
  tenant_sending_domain_set_status: "p_tenant_id",
  touch_domain_warmup: "p_tenant_id",
  site_traffic_stats: "p_tenant_id",
  record_site_photos: "p_tenant_id",
  photo_retry_free: "p_tenant_id",
  claim_photo_retry: "p_tenant_id",
  site_set_thumbnail: "p_tenant_id",
  expire_parked_look_run: "p_tenant_id",
  pick_parked_look: "p_tenant_id",
  site_set_preview_snapshot: "p_tenant_id",
  site_mark_preview_changed: "p_tenant_id",
};

export function tenantRpc(
  tid: TenantId,
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  const argName = RPC_TENANT_ARG[name];
  if (!argName) {
    throw new Error(`tenantRpc: RPC '${name}' is not in the tenant-RPC registry (tenant-client.ts). Add it (with its tenant arg name) after review.`);
  }
  const existing = args[argName];
  if (existing !== undefined && existing !== null && existing !== tid) {
    throw new Error(`tenantRpc: '${name}' called with ${argName}=${String(existing)} != scope ${tid}.`);
  }
  return serviceClient().rpc(name, { ...args, [argName]: tid });
}

const PRE_TENANT_RPCS: ReadonlySet<string> = new Set([
  "human_resolve_brief",
  "human_resolve_application",
  "creator_resolve_thread",
  "creator_resolve_offer",
  "geo_resolve_prompt_sweep",
  "geo_resolve_crawler_ingest_token",
  "setup_draft_resolve_run",
  "email_bulk_resolve_recipient",
  "db_connector_resolve_pair_code",
  "db_connector_resolve_token",
]);

export function preTenantRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!PRE_TENANT_RPCS.has(name)) {
    throw new Error(
      `preTenantRpc: '${name}' is not in the pre-tenant RPC allowlist (tenant-client.ts). Pre-tenant RPCs must be read-only tenant RESOLVERS; use tenantRpc once the tenant is known.`,
    );
  }
  return serviceClient().rpc(name, args);
}

const CREATOR_ORDER_RPCS: ReadonlySet<string> = new Set([
  "creator_claim_order_transfer",
  "creator_mark_order_transferred",
  "creator_release_order_transfer_claim",
  "creator_claim_due_order_deadlines",
  "creator_claim_order_deadline",
  "creator_release_order_deadline_lease",
]);

export function creatorOrderRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!CREATOR_ORDER_RPCS.has(name)) {
    throw new Error(
      `creatorOrderRpc: '${name}' is not a creator transfer-claim RPC (tenant-client.ts). Use tenantClient/tenantRpc for tenant-scoped work.`,
    );
  }
  return serviceClient().rpc(name, args);
}

const PLATFORM_SECRET_RPCS: ReadonlySet<string> = new Set([
  "get_platform_secret",
  "set_platform_secret",
  "rotate_platform_secret_cas",
]);

const SHOPIFY_RPCS: ReadonlySet<string> = new Set([
  "mint_shopify_oauth_state",
  "consume_shopify_oauth_state",
  "store_shopify_pending_installation",
  "get_shopify_pending_installation",
  "get_shopify_installation_status",
  "reserve_shopify_pending_installation",
  "rotate_shopify_pending_tokens",
  "set_shopify_pending_composio_account",
  "complete_shopify_pending_installation",
  "list_shopify_token_refresh_candidates",
  "mark_shopify_composio_token_synced",
  "delete_shopify_installation_for_tenant",
  "acquire_shopify_refresh_lease",
  "release_shopify_refresh_lease",
  "list_shopify_pending_composio_accounts_for_shop",
  "delete_shopify_pending_installation_for_shop",
  "shopify_connections_for_shop",
  "record_shopify_privacy_request",
  "delete_shopify_app_member_links_for_shop",
]);

export function shopifyRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!SHOPIFY_RPCS.has(name)) {
    throw new Error(`shopifyRpc: '${name}' is not a Shopify install RPC (tenant-client.ts). Use tenantClient/tenantRpc for tenant-scoped work.`);
  }
  return serviceClient().rpc(name, args);
}

export function platformSecretRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!PLATFORM_SECRET_RPCS.has(name)) {
    throw new Error(
      `platformSecretRpc: '${name}' is not a platform-secret RPC (tenant-client.ts). Use tenantClient/tenantRpc for tenant-scoped work.`,
    );
  }
  return serviceClient().rpc(name, args);
}

export function publicLiveStatsAggregate(): ReturnType<SupabaseClient["rpc"]> {
  return serviceClient().rpc("public_live_stats");
}

export function creatorTimerClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("creatorTimerClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export const __testing = {
  scopeKind,
  registerForTest(table: string, kind: ScopeKind): void {
    REGISTRY[table] = kind;
  },
  unregisterForTest(table: string): void {
    delete REGISTRY[table];
  },
  registerSafeEmbedForTest(rel: string): void {
    SAFE_EMBEDDED_RELATIONS.add(rel);
  },
};

export async function resolveAdsWalletOrderTenant(orderId: string): Promise<TenantId> {
  if (!orderId) throw new Error("Ads wallet order ID is required");
  const { data, error } = await serviceClient().from("ads_wallet_orders")
    .select("tenant_id").eq("id", orderId).single();
  if (error || !data?.tenant_id) throw new Error("Ads wallet order could not be resolved");
  return asTenantId(data.tenant_id);
}

export async function applyAdsWalletPayment(tid: TenantId, args: {
  p_order_id: string; p_payment_intent_id: string; p_net_cents: number; p_event_created: number;
}) {
  const { data, error } = await tenantClient(tid).from("ads_wallet_orders")
    .select("id").eq("id", args.p_order_id).single();
  if (error || !data) throw new Error("Ads payment order does not belong to this workspace");
  return serviceClient().rpc("ads_wallet_apply_payment", args);
}

export async function setCustomDomainVerifyState(tid: TenantId, args: {
  p_id: string; p_status: "verified" | "verifying"; p_last_error: null;
}) {
  const { data, error } = await tenantClient(tid).from("tenant_custom_domains")
    .select("id").eq("id", args.p_id).single();
  if (error || !data) throw new Error("Custom domain does not belong to this workspace");
  return serviceClient().rpc("set_tenant_custom_domain_state", args);
}

const START_CARD_RPCS: ReadonlySet<string> = new Set([
  "start_card_budget_reserve",
  "start_card_budget_adjust",
  "start_card_set_part",
  "start_card_claim",
  "start_card_seed_claim",
  "seed_notice_claim",
  "seed_notice_accepted",
  "seed_run_reserve",
  "seed_run_settle",
  "seed_notice_claim_capped",
  "seed_notice_unsubscribe",
  "tick_enrichment_rate_limit",
]);

export async function benchSeatCooldownRpc(seat: string, untilIso: string, reason: string): Promise<void> {
  const { error } = await serviceClient().rpc("bench_seat_cooldown", { p_seat: seat, p_until: untilIso, p_reason: reason });
  if (error) throw new Error(error.message);
}

export async function recordSeatUsageRpc(args: {
  seat: string;
  rateLimitType: string;
  status: string;
  utilization: number | null;
  resetsAtIso: string | null;
  observedAtIso: string;
}): Promise<void> {
  const { error } = await serviceClient().rpc("record_seat_usage", {
    p_seat: args.seat,
    p_rate_limit_type: args.rateLimitType,
    p_status: args.status,
    p_utilization: args.utilization,
    p_resets_at: args.resetsAtIso,
    p_observed_at: args.observedAtIso,
  });
  if (error) throw new Error(error.message);
}

export class StaleRevisionError extends Error {
  constructor() {
    super("stale_revision");
  }
}

export async function applySecretListEditRpc(args: {
  key: string;
  expectedRevision: string | null;
  value: string;
  description: string;
  noteUpserts: Array<{ seat: string; note: string }>;
  noteDeletes: string[];
  actor: string;
}): Promise<string> {
  const { data, error } = await serviceClient().rpc("apply_secret_list_edit", {
    p_key: args.key,
    p_expected_updated_at: args.expectedRevision,
    p_value: args.value,
    p_description: args.description,
    p_note_upserts: args.noteUpserts,
    p_note_deletes: args.noteDeletes,
    p_actor: args.actor,
  });
  if (error) {
    if (error.message === "stale_revision") throw new StaleRevisionError();
    throw new Error(error.message);
  }
  return String(data);
}

export async function consumeTenantRateLimit(
  tenantId: TenantId,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("tick_enrichment_rate_limit", {
    p_key: `tenant:${tenantId}:${bucket}`,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function stampTenantMarker(tenantId: TenantId, bucket: string, at: Date = new Date()): Promise<void> {
  const { error } = await serviceClient()
    .from("enrichment_rate_limit")
    .upsert({ key: `tenant:${tenantId}:${bucket}`, window_start: at.toISOString(), count: 0 }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

export async function clearTenantMarker(tenantId: TenantId, bucket: string): Promise<void> {
  const { error } = await serviceClient().from("enrichment_rate_limit").delete().eq("key", `tenant:${tenantId}:${bucket}`);
  if (error) throw new Error(error.message);
}

export async function tenantMarkerAt(tenantId: TenantId, bucket: string): Promise<number | null> {
  const { data, error } = await serviceClient()
    .from("enrichment_rate_limit")
    .select("window_start")
    .eq("key", `tenant:${tenantId}:${bucket}`)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const at = Date.parse(String((data as { window_start?: unknown } | null)?.window_start ?? ""));
  return Number.isNaN(at) ? null : at;
}

const CREATOR_INVITE_RPCS: ReadonlySet<string> = new Set([
  "creator_invite_existing_accounts",
  "creator_invite_stamp",
  "creator_invite_link_signup",
  "creator_invite_reconcile_links",
  "creator_invite_message_claim_email",
]);

export function creatorInviteRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!CREATOR_INVITE_RPCS.has(name)) {
    throw new Error(`creatorInviteRpc: '${name}' is not a creator-invite RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const ONBOARDING_EMAIL_RPCS: ReadonlySet<string> = new Set([
  "onboarding_email_claim",
  "onboarding_email_release",
  "onboarding_email_unsubscribe",
  "onboarding_email_claim_step",
  "onboarding_email_release_step",
]);

export function onboardingEmailRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!ONBOARDING_EMAIL_RPCS.has(name)) {
    throw new Error(`onboardingEmailRpc: '${name}' is not an onboarding-email RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const AFFILIATE_RPCS: ReadonlySet<string> = new Set([
  "affiliate_attribute",
  "affiliate_accrue",
  "affiliate_refund",
  "affiliate_credit_note",
  "affiliate_dispute",
  "affiliate_payout_claim",
  "affiliate_payout_move",
  "affiliate_reversal_claim",
  "affiliate_reversal_move",
  "affiliate_member_totals",
  "affiliate_payout_start",
  "affiliate_members_to_visit",
  "affiliate_purge_clicks",
  "affiliate_inbox_fail",
  "affiliate_reversal_start",
  "affiliate_reversal_external",
]);

export function affiliateRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!AFFILIATE_RPCS.has(name)) {
    throw new Error(`affiliateRpc: '${name}' is not an affiliate RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

export function startCardRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!START_CARD_RPCS.has(name)) {
    throw new Error(`startCardRpc: '${name}' is not a start-card RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const VENDOR_USAGE_RPCS: ReadonlySet<string> = new Set([
  "reconcile_vendor_usage_day",
  "vendor_usage_apify_workloads",
]);

export function vendorUsageRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!VENDOR_USAGE_RPCS.has(name)) {
    throw new Error(`vendorUsageRpc: '${name}' is not a vendor-usage RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const SITE_PUBLIC_RPCS: ReadonlySet<string> = new Set([
  "site_by_hostname",
  "site_by_repo",
  "site_claim_idle_batch",
  "site_reaper_candidates",
  "site_auth_directory",
  "site_projection_drift_batch",
  "site_form_notify_target",
  "site_form_notify_set_muted",
]);

export function sitePublicRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!SITE_PUBLIC_RPCS.has(name)) {
    throw new Error(`sitePublicRpc: '${name}' is not a site public RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const SITE_SHARD_RPCS: ReadonlySet<string> = new Set([
  "site_shard_register",
  "site_shard_update",
  "site_shard_record_metrics",
  "site_shard_list",
  "site_shard_get",
  "site_shard_secret_set",
  "site_shard_secret_get",
  "site_shard_migration_record",
  "site_graduation_due",
  "site_graduation_request_by_site",
  "site_backend_settings_set",
  "site_backend_settings_get",
  "site_backend_turnstile_secret",
  "site_graduation_status",
  "site_shard_autoprov_claim",
  "site_shard_autoprov_finish",
  "site_shard_autoprov_set_paused",
  "site_shard_autoprov_status",
  "site_shard_autoprov_notice",
  "site_shard_guard_acquire",
  "site_shard_guard_release",
  "site_shard_guard_begin_create",
  "site_shard_guard_end_create",
  "site_shard_guard_staff_recover",
  "site_shard_validation_ready",
  "site_test_site_due",
  "site_test_site_stats",
  "site_test_site_states",
  "site_is_validation",
  "site_shard_placement_pause",
  "site_shard_placement_resume",
  "site_shard_capacity_inputs",
  "site_shard_metrics_alert_claim",
  "site_shard_rollout_claim",
  "site_shard_rollout_release",
  "site_shard_placement_pause_unless_held",
  "site_shard_placement_readiness",
]);

export function siteShardRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!SITE_SHARD_RPCS.has(name)) {
    throw new Error(`siteShardRpc: '${name}' is not a site shard RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const OPS_RPCS: ReadonlySet<string> = new Set([
  "claim_ops_alerts",
  "finish_ops_alert",
  "claim_team_report_pings",
  "finish_team_report_ping",
  "team_report_ping_due_at",
  "list_failed_open_channel_actions",
  "list_open_card_channels",
  "email_redispatch_released_sweep",
  "email_redispatch_enqueue_failed",
  "email_bulk_stalled_sends",
  "email_bulk_refire_enqueue_failed",
]);

const SITE_FUNCTION_RPCS: ReadonlySet<string> = new Set([
  "site_fn_schedules_due",
  "site_fn_schedule_fire",
  "site_fn_runs_claim",
  "site_fn_run_finish",
  "site_fn_run_leased",
  "site_fn_logs_insert",
  "site_fn_secrets_for_scripts",
  "site_fn_reconcile_begin",
  "site_fn_reconcile_end",
  "site_fn_dirty_sites",
  "site_fn_sweep_candidates",
  "site_fn_script_deleted",
  "site_fn_teardown_begin",
  "site_fn_teardown_finish",
  "site_fn_retention",
]);

export function siteFunctionsRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!SITE_FUNCTION_RPCS.has(name)) {
    throw new Error(`siteFunctionsRpc: '${name}' is not a site-functions platform RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

const DB_CONNECTOR_PLATFORM_RPCS: ReadonlySet<string> = new Set([
  "db_connector_pair_reserve",
  "db_connector_pair_refund",
  "purge_db_connector_requests",
  "claim_db_connector_failing_alerts",
  "claim_db_connector_discovery_outbox",
  "claim_db_connector_offline_notices_due",
  "seed_db_rediscovery_backfill",
  "claim_db_rediscovery_backfill",
  "ack_db_rediscovery_backfill",
  "db_rediscovery_backfill_backlog",
  "claim_db_rescan_retries",
]);

export function connectorWakeupClient(reason: string): SupabaseClient {
  if (!reason || reason.trim().length < 8) {
    throw new Error("connectorWakeupClient: a substantive reason string is required.");
  }
  return serviceClient();
}

export function dbConnectorPlatformRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!DB_CONNECTOR_PLATFORM_RPCS.has(name)) {
    throw new Error(`dbConnectorPlatformRpc: '${name}' is not a Zavi Connector platform RPC (tenant-client.ts).`);
  }
  return serviceClient().rpc(name, args);
}

export function opsRpc(
  name: string,
  args: Record<string, unknown> = {},
): ReturnType<SupabaseClient["rpc"]> {
  if (!OPS_RPCS.has(name)) {
    throw new Error(`opsRpc: '${name}' is not an ops RPC (tenant-client.ts). Use tenantClient/tenantRpc for tenant-scoped work.`);
  }
  return serviceClient().rpc(name, args);
}
