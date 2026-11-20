
export const PROD_REF = "wmycgyjsenvgtczlupoe";
export const STAGING_REF = "dgzgwclslzzzrjopbobp";
const FORBIDDEN_REFS = new Set([PROD_REF, STAGING_REF]);

export function refFromApiUrl(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(String(url ?? "").trim().toLowerCase());
  if (!m) throw new Error("mirror API URL must look like https://<ref>.supabase.co");
  return m[1];
}

export function parsePgUri(uri) {
  const m = /^postgres(?:ql)?:\/\/([^:]+):(.*)@([^@:/]+)(?::(\d+))?\/([^?]+)/.exec(uri ?? "");
  if (!m) throw new Error("not a postgres:// connection string");
  return {
    user: decodeURIComponent(m[1]),
    password: m[2],
    host: m[3].toLowerCase(),
    port: Number(m[4] || 5432),
    database: m[5],
  };
}

export function refFromDbUri(uri) {
  const c = parsePgUri(uri);
  const userRef = /^[a-z_][a-z0-9_]*\.([a-z0-9]{20})$/.exec(c.user.toLowerCase())?.[1] ?? null;
  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(c.host)?.[1] ?? null;
  const pooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(c.host);
  if (direct) {
    if (userRef && userRef !== direct) throw new Error("connection user and host name different Supabase projects");
    return direct;
  }
  if (pooler && userRef) return userRef;
  throw new Error("cannot tell which Supabase project this connection string targets");
}

export function resolveMirrorTarget({ apiUrl, dbUri, expectedRef }) {
  const want = String(expectedRef ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(want)) throw new Error("MIRROR_PROJECT_REF must be the 20-character mirror project ref");
  if (FORBIDDEN_REFS.has(want)) throw new Error(`refusing: MIRROR_PROJECT_REF is ${want === PROD_REF ? "PROD" : "shared STAGING"}`);
  const api = apiUrl == null ? want : refFromApiUrl(apiUrl);
  const db = refFromDbUri(dbUri);
  for (const [what, ref] of [["API URL", api], ["DB connection", db]]) {
    if (FORBIDDEN_REFS.has(ref)) throw new Error(`refusing: mirror ${what} is ${ref === PROD_REF ? "PROD" : "shared STAGING"}`);
    if (ref !== want) throw new Error(`mirror ${what} targets ${ref}, not MIRROR_PROJECT_REF ${want}`);
  }
  if (parsePgUri(dbUri).port !== 5432) throw new Error("MIRROR_DB_URL must be a session connection (port 5432), not the transaction pooler");
  return want;
}

export const TABLE_ALLOWLIST = new Set([
  "action_outcomes", "activity_events", "ad_budget_events", "ad_budget_shadow_verdicts", "ad_budget_snapshots",
  "ad_budgets", "ad_campaigns", "ad_hold_live_reads", "ad_location_choices", "ad_object_changes",
  "ad_set_strategist_reviews", "ad_spend_daily", "admin_action_log", "admin_correction_eval_cases",
  "admin_correction_ledger", "admin_tasks", "ads_account_bindings", "ads_account_selections",
  "ads_campaign_bindings", "ads_creative_uploads", 
  "advisor_recommendations", "agent_asks", "agent_clarification_responses", "agent_csat_daily",
  "agent_decisions_not_taken", "agent_email_recipients", "agent_engagement_signals", "agent_feedback",
  "agent_improvement_requests", "agent_run_batches", "agent_run_side_costs", "agent_run_steers", "agent_run_trace", "agent_runs", "agent_seen_marker", "agent_setup_state",
  "agent_shadow_runs", "agent_thread_messages", "agent_thread_seen_marker", "agent_threads", "agent_tool_effects",
  "autopilot_action_ledger", "autopilot_goal_changes", "autopilot_goals", "batch_fanout_refunds",
  "booking_daily_rollup", "booking_metric_config", "brief_applications", "build_chip_more_claims",
  "cgo_autopilot_audit", "cgo_autopilot_state", "cgo_hypotheses", "cgo_notes", "cgo_questions", "cgo_wake_skips",
  "channel_action_events", "channel_actions", "channel_metrics", "channel_run_claims", "channel_settings",
  "code_index_builds", "code_index_state", "company_profiles",
  "competitor_snapshots", "conductor_runs", "connector_app_requests", "connector_metadata",
  "connector_ticket_ledger", "creator_briefs", "creator_disputes", "creator_library_assets",
  "creator_money_events", "creator_notifications", "creator_offers", "creator_orders", "creator_submissions",
  "creator_thread_messages", "creator_threads", "custom_agent_triggers", "custom_agent_write_receipts",
  "custom_agents", "data_access_log", "db_rediscovery_backfill", "db_run_retention", "db_run_retention_tenants",
  "decision_revision_requests", "decision_suppressions", "decisions", "delegation_lineage", "digest_send_audit",
  "discord_guilds", "discord_reply_claims", "dispatch_history", "dispatch_notice_refs", "distill_budget_ledger",
  "dream_candidates", "dream_cycle_runs", "dream_cycle_verdicts", "email_learn_state", "email_learning_reads",
  "email_messages", "email_threads", "email_triage_claims", "email_triage_window",
  "engineer_html_preview_artifacts", "engineer_prototype_links", "eval_capture_failures",
  "extension_consent", "extension_screenshots", "extracted_artifacts", "fundraising_investor",
  "fundraising_outreach_state", "fundraising_raise", "fundraising_review_state", "fundraising_round_config",
  "generative_video_jobs", "geo_prompt_responses", "geo_prompt_sweeps", "geo_prompts", "geo_robots_observations",
  "growth_diagnosis_provenance", "growth_intake_research", "growth_plan", "growth_plan_bets",
  "growth_plan_changes", "growth_suggestion_messages", "growth_suggestion_sessions", "growth_suggestions",
  "handoff_batches", "higgsfield_generate_attempts", "higgsfield_generate_counters", "inbox_handle_ledger",
  "ingested_events", "live_source_hourly", "live_source_push", "live_stunt_days", "live_stunt_snapshots",
  "low_conf_dispatches", "mapping_confirmed", "marketplace_geo_category_weekly", "material_news_emitted",
  "mcp_tool_calls", "meeting_atoms", "memory_chunk", "memory_conflict_pair", "memory_entity",
  "memory_mutation_audit", "memory_note", "memory_note_entity", "memory_recall_golden",
  "memory_relation", "memory_signal", "memory_write_log", "metric_incidents",
  "metric_moves", "news_digest_deliveries", "news_findings", "news_scan_claims", "news_topics",
  "notification_settings", "onboarding_step_events", "perf_dashboard_snapshots", "pm_roadmap",
  "reddit_ad_monitor_state", "reddit_comments", "reddit_community_stats", "reddit_mentions",
  "reddit_metric_snapshots", "reddit_sweeps", "reddit_threads", "refine_suggestions",
  "regression_signature_occurrences", "repeat_task_ab_metrics", "repeat_task_golden", "repo_profiles",
  "research_evidence", "run_artifacts", "seo_audit_snapshots", "setup_draft_admissions",
  "shared_pages",  
  "slack_channel_members", "slack_channels", "slack_message_index", "slack_source_message_lifecycle",
  "slack_triage_claims", "slack_triage_window", "slack_workspaces", "social_account_snapshots",
  "social_post_metric_snapshots", "social_posts", "staff_audit_log", "starter_autostart_claims", "takes",
  "team_discover_jobs", "team_member_identities", "team_members", "team_note_judge_claims", "team_note_offers",
  "team_reports", "teams_reply_claims", "teams_tenants", "telegram_chats", "telegram_reply_claims",
  "tenant_agent_email_identity", "tenant_agent_schedules", "tenant_agents", "tenant_app_setting",
  "tenant_brand_kits", "tenant_budget_counters", "tenant_budget_override", "tenant_build_credits",
  "tenant_channels", "tenant_commands", "tenant_config_audit", "tenant_connector_skill", "tenant_credit_balances",
  "tenant_credit_ledger", "tenant_db_catalog", "tenant_db_generation", "tenant_db_settings",
  "tenant_decision_class_overrides", "tenant_document", "tenant_email_allowlist", "tenant_fact",
  "tenant_feedback", "tenant_first_run_progress", "tenant_local_lane", "tenant_mcp_servers",
  "tenant_meeting_settings", "tenant_metered_read_counters", "tenant_metric_snapshots", "tenant_personalization",
  "tenant_personalization_history", "tenant_readiness", "tenant_retention_policy", "tenant_routines",
  "tenant_rules", "test_cases", "thread_event", "tiktok_ad_launches", "tool_charges",
  "user_prefs", "vendor_usage", "voice_sessions", "whatsapp_threads", "workspace_agent_pins",
]);

export const WINDOW_DAYS = 14;
export const WINDOW_MIN_ROWS = 2000;

export const PRESERVE_FOREVER = new Set(["inbox_handle_ledger"]);

export const BUDGET = { maxRows: 1_500_000, maxBytes: 350e6, maxDatabaseBytes: 480e6, dbMarginBytes: 30e6, maxStorageBytes: 2e9, maxFiles: 20_000, maxMinutes: 30 };

export const WINDOW_COLUMNS = ["created_at", "enqueued_at", "emitted_at", "received_at", "inserted_at", "occurred_at"];

export function planTable(table, columns, rowCount) {
  if (!TABLE_ALLOWLIST.has(table)) return { action: "skip", reason: "not on the mirror allowlist" };
  if (!columns.includes("tenant_id")) return { action: "skip", reason: "no tenant_id" };
  if (rowCount === 0) return { action: "skip", reason: "empty" };
  const sinceColumn = rowCount > WINDOW_MIN_ROWS ? WINDOW_COLUMNS.find((c) => columns.includes(c)) ?? null : null;
  return { action: "copy", sinceDays: sinceColumn ? WINDOW_DAYS : null, sinceColumn };
}

const SECRET_FAMILIES = [
  "google_ads", "google_analytics", "google_search_console", "google_sheets", "google_calendar",
  "meta_ads", "slack", "jira", "linear", "intercom", "linkedin_ads", "linkedin_social", "x_social", "x_ads",
  "tiktok", "tiktok_ads", "reddit_ads", "reddit_social", "reddit_api", "pinterest_ads", "spotify_ads",
  "microsoft_ads", "snapchat_ads", "instagram_social", "higgsfield", "teams", "telegram", "whatsapp", "discord",
  "sendgrid", "email",
];

export function secretAllowed(key) {
  const family = String(key).split(/[.:]/)[0];
  return SECRET_FAMILIES.includes(family);
}

export function connectorFamily(id) {
  return String(id).split(/[.:]/)[0];
}

export function connectorKept(id, carriedFamilies) {
  const s = String(id);
  if (s.startsWith("composio") || s.startsWith("pipedream")) return false;
  return carriedFamilies.has(connectorFamily(s));
}

export function carriedFamilies(keys) {
  return new Set(keys.filter(secretAllowed).map((k) => connectorFamily(k)));
}

export function insertableColumns(cols) {
  return cols.filter((c) => c.is_generated !== "ALWAYS").map((c) => c.column_name);
}

export function schemaMismatches(prod, mirror, tables, prodEnums = new Map(), mirrorEnums = new Map()) {
  const out = [];
  const type = (c) =>
    `${c.data_type}:${c.udt_name}:${c.character_maximum_length ?? ""}:${c.numeric_precision ?? ""}:${c.numeric_scale ?? ""}:${c.datetime_precision ?? ""}`;
  for (const t of tables) {
    const a = prod.get(t) ?? [];
    const b = mirror.get(t);
    if (!b) {
      out.push(`${t}: missing in mirror`);
      continue;
    }
    const mb = new Map(b.map((c) => [c.column_name, c]));
    const ma = new Set(a.map((c) => c.column_name));
    for (const c of a) {
      const m = mb.get(c.column_name);
      if (!m) out.push(`${t}.${c.column_name}: missing in mirror`);
      else if (type(m) !== type(c)) out.push(`${t}.${c.column_name}: prod ${type(c)}, mirror ${type(m)}`);
      else if (c.is_nullable === "YES" && m.is_nullable === "NO") out.push(`${t}.${c.column_name}: nullable in prod, NOT NULL in mirror`);
    }
    for (const m of b) {
      if (ma.has(m.column_name)) continue;
      const fillable = m.is_nullable === "YES" || m.column_default != null || m.is_generated === "ALWAYS" || m.is_identity === "YES";
      if (!fillable) out.push(`${t}.${m.column_name}: mirror-only and required with no default`);
    }
  }
  for (const [name, labels] of prodEnums) {
    const m = mirrorEnums.get(name) ?? [];
    const missing = labels.filter((l) => !m.includes(l));
    if (missing.length) out.push(`enum ${name}: mirror lacks [${missing.join(", ")}]`);
  }
  return out;
}

export function scrubConfigBlob(blob) {
  const bad = /(secret|token|password|api_?key|private|credential)/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (!bad.test(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(blob ?? {});
}

export function pickActiveTenant(prodActive, memberTenantIds) {
  if (prodActive && memberTenantIds.includes(prodActive)) return prodActive;
  return [...memberTenantIds].sort()[0] ?? null;
}

export function fkRepair(fk) {
  const nullable = fk.cols.filter((_, i) => !fk.notnull[i]);
  if (fk.match === "s" && nullable.length) return { action: "null", cols: nullable };
  if (fk.match === "f" && nullable.length === fk.cols.length) return { action: "null", cols: nullable };
  return { action: "delete" };
}

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(out, m[1])) throw new Error(`duplicate key ${m[1]} in env file`);
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export const PROD_API_URL = `https://${PROD_REF}.supabase.co`;
export function assertProdSource({ apiUrl, dbUri }) {
  if (String(apiUrl ?? "").trim().replace(/\/$/, "").toLowerCase() !== PROD_API_URL) throw new Error("prod SUPABASE_URL must be exactly " + PROD_API_URL);
  if (refFromDbUri(dbUri) !== PROD_REF) throw new Error("prod read-only connection does not target the prod project");
}

export const ACCESS_TOKEN_HOOK_URI = "pg-functions://postgres/public/custom_access_token_hook";
export const PROD_AUTH_HOOKS = { hook_custom_access_token_enabled: true, hook_custom_access_token_uri: ACCESS_TOKEN_HOOK_URI };

export function authConfigGaps(config) {
  return Object.entries(PROD_AUTH_HOOKS)
    .filter(([k, v]) => config?.[k] !== v)
    .map(([k, v]) => `${k} is ${JSON.stringify(config?.[k] ?? null)}, prod has ${JSON.stringify(v)}`);
}

export async function syncAuthHooks({ ref, token, fetch }) {
  if (FORBIDDEN_REFS.has(ref)) throw new Error(`refusing: auth config target is ${ref === PROD_REF ? "PROD" : "shared STAGING"}`);
  if (!token) throw new Error("~/.zavi/mirror.env is missing SUPABASE_ACCESS_TOKEN (a Supabase access token that can manage the mirror project); without it the mirror's auth hooks cannot be matched to prod");
  const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const patched = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(PROD_AUTH_HOOKS) });
  if (!patched.ok) throw new Error(`mirror auth config update failed: HTTP ${patched.status}`);
  const read = await fetch(url, { method: "GET", headers });
  if (!read.ok) throw new Error(`mirror auth config read failed: HTTP ${read.status}`);
  const gaps = authConfigGaps(await read.json());
  if (gaps.length) throw new Error(`mirror auth config still differs from prod:\n  ${gaps.join("\n  ")}`);
}

export const CREATOR_TABLES = ["human_members", "human_member_handles", "creator_packages"];

export function mirrorCreatorEmail(authUserId) {
  return `${authUserId}@mirror.invalid`;
}

export function planCreatorCopy({ creators, handles, packages, memberIds, prevCreatorIds = [] }) {
  const ids = new Set(creators.map((c) => c.id));
  const members = new Set(memberIds);
  return {
    creators,
    handles: handles.filter((h) => ids.has(h.human_member_id)),
    packages: packages.filter((p) => ids.has(p.human_member_id) && p.active === true),
    logins: creators.filter((c) => !members.has(c.auth_user_id)).map((c) => ({ id: c.auth_user_id, email: mirrorCreatorEmail(c.auth_user_id) })),
    authUserIds: creators.map((c) => c.auth_user_id),
    wipeIds: [...new Set([...prevCreatorIds, ...ids])],
  };
}

export function activeTenantClaim(accessToken) {
  const payload = String(accessToken ?? "").split(".")[1];
  if (!payload) return null;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.app_metadata?.active_tenant_id;
    return typeof claim === "string" && claim ? claim : null;
  } catch {
    return null;
  }
}
