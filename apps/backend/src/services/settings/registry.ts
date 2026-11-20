
export type SettingType = "boolean" | "number" | "string" | "json";
export type SettingScope = "global" | "per-tenant";

export type SettingDef = {
  description: string;
  type: SettingType;
  scope: SettingScope;
  defaultValue: boolean | number | string | Record<string, unknown> | unknown[];
  min?: number;
  max?: number;
  options?: readonly string[];
  secret?: boolean;
  secretList?: boolean;
};

export const APP_SETTINGS = {
  memory_reranker_enabled: {
    description: "Two-stage Voyage rerank-2.5 over a widened OR pool in hybrid search.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  slack_cross_surface_rollover: {
    description:
      "Inject permission-checked related context from the asker's prior Slack threads on a new top-level Slack message (Viktor parity Gap 2).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  founder_rules_enabled: {
    description:
      "Load a company's saved rules into its agents' prompts and offer 'keep this as a rule' suggestions. Default ON. When false, no rule reaches any prompt and no suggestion is made (kill switch).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  growth_constraint_card_enabled: {
    description:
      "Serve the growth-lead binding-constraint diagnosis card + run its operator-DB compute. Default ON. When false (per-tenant or fleet), the endpoint returns disabled and the card is hidden (kill-switch).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  built_app_operator_db_enabled: {
    description:
      "Connect a Zavi-built app's database as the tenant's Operator DB (read-only role) and auto-confirm its unambiguous users/bookings mapping. Default ON. Never touches a founder-connected database.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  metric_anomaly_alerts_enabled: {
    description:
      "Daily anomaly watch: bad metric incidents alert the owner (Slack, else email) and may wake the head of growth. Default ON. When false (per tenant or fleet), no reads, no incidents, no alerts, no wakes (kill switch).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  anomaly_alerts_mode: {
    description:
      "Anomaly alerts: 'shadow' (default) records incidents and the would-have-sent message, sends nothing, wakes nothing. 'on' sends one message per bad incident and wakes the head of growth.",
    type: "string",
    scope: "global",
    defaultValue: "shadow",
    options: ["shadow", "on"],
  },
  cgo_hypothesis_gate_enforced: {
    description:
      "Enforce cgo's hypothesis gate: a move must name a hypothesis, copy work needs a confirmed one, engineer/pm need confirmed + a checked gain. Default OFF = shadow (logged, nothing blocked).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  cgo_autopilot_enabled: {
    description:
      "Let cgo act as the tenant's head of growth: alarm reviews, its own check-in rhythm, goal changes with undo, pausing plan-picked channels. Default OFF. When false, cgo only emails weekly advice and changes nothing.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  welcome_setup_enabled: {
    description:
      "Show the 3-step welcome setup (past work, connectors, polish) and lock the sidebar until it is finished. Default ON. When false (per tenant or fleet), today's behaviour everywhere (kill switch).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  tenant_executable_skills_enabled: {
    description:
      "Allow tenant-AUTHORED executable routines to be callable by the tenant's agents. Default ON. When false (per-tenant or fleet), tenant-authored routines are not injected as tools (kill-switch); machine-distilled routines are unaffected.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  html_card_scripts_enabled: {
    description:
      "Allow inline JavaScript inside agent-drawn html cards (no network). Default OFF pending Ravi. When false, scripts and handlers are stripped and the card is static.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  copilotkit_transport_enabled: {
    description:
      "Serve the CopilotKit (AG-UI/SSE) transport at /api/copilotkit for this tenant. Default ON. When false the endpoint answers 404 and the web uses the plain chat path (kill-switch).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  brain_eval_patterns: {
    description: "Pattern-note ingestion + boost.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  brain_gap_distill: {
    description: "Write knowledge-gap notes from failed-run signals.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  memory_stale_archive_enabled: {
    description:
      "Soft-archive very-old/low-trust/low-salience/unreferenced memory notes out of recall (reversible). Default ON fleet-wide 2026-06-30 (Ravi); a tenant can still opt out with an explicit false override.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_readtime_contradiction: {
    description:
      "Surface general (status/policy/fact) contradictions among recalled notes at read time, in addition to the always-on numeric contradiction banner. Default ON fleet-wide 2026-06-30 (Ravi); a tenant can still opt out with an explicit false override.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_recall_floor: {
    description:
      "Min rerank relevance score (0..1) for a hit to be injected as recall context (rerank path only). 0 = no floor; tuned up from the golden eval after dedup.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 0,
    min: 0,
    max: 1,
  },
  memory_index_kind: {
    description: "ANN index strategy for memory_chunk embedding search: none | ivfflat | hnsw.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "none",
  },
  governed_chokepoint: {
    description: "Governed-action chokepoint mode for consequential external agent actions (slack/email/jira/linear/github/stripe + remote writes): off | shadow | enforce.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "enforce",
    options: ["off", "shadow", "enforce"] as const,
  },
  llm_role_model_overrides: {
    description:
      "Per-role LLM model override map (role → model id). Ships with daily-brief synth on Haiku fleet-wide; per-tenant rows override.",
    type: "json",
    scope: "per-tenant",
    defaultValue: { synthMarkdown: "claude-haiku-4-5-20251001" },
  },
  cross_customer_learning_consent: {
    description:
      "Per-tenant opt-in to let Praxis learn anonymized cross-customer patterns. Default OFF; grantable per-tenant only (a global enable is rejected).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  autopilot_trust_level: {
    description:
      "Autopilot trust-ladder level. 'L0' (default) = fully supervised, every daily plan needs a human click. 'L1' = this tenant's autopilot.daily-plan decisions auto-approve at emit (same approval path as a click); money/Slack classes unaffected, never_auto clamps still win. L2/L3 reserved — unknown values resolve to L0.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "L0",
    options: ["L0", "L1"],
  },
  build_app_intent: {
    description:
      "Whether this tenant intends to BUILD a fresh app via Praxis ('fresh') or CONNECT an existing app they already have ('existing'). Drives the /workspace home BuildAppCard visibility. Default 'existing' so pre-existing tenants never see the build-app card without explicit opt-in.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "existing",
  },
  company_scale_segment: {
    description:
      "Self-reported company scale segment for has-product tenants: 'pre_revenue' | 'early' (0->$1M) | 'scaling' (~$1M) | 'mature' ($10M+). Drives segment-aware /workspace lead copy. Asked explicitly in onboarding only on the has-product branch; default '' (unset) = generic framing. Not shown to fresh-build tenants.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "",
  },
  slack_approval_push_enabled: {
    description:
      "PUSH pending approval cards to the tenant's Slack #zavi channel (or the owner's DM) via the approval-slack-notify cron. Default OFF (opt-in, 2026-09-07). Approvals remain live + actionable on the web (Needs you, Growth page, channel tiles) regardless — this key only decides whether Slack is told. Does not affect in-thread replies to Slack-originated runs.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  slack_connector_alert_enabled: {
    description:
      "PUSH connector-health warnings ('Meta Ads expires in 7 days, reconnect here') to the tenant's Slack. Default OFF (opt-in, 2026-09-07). The connector tile in Settings still shows the same expiry state when this is off.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  autopilot_digest_push_enabled: {
    description:
      "Daily PUSH of the morning-brief digest ('what autopilot did overnight') to the tenant's Slack #zavi channel. Default OFF (opt-in, 2026-09-07); explicit per-tenant ON required. PULL /api/workspace/morning-brief is unaffected.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  autopilot_digest_email_enabled: {
    description:
      "Daily EMAIL of the morning-brief digest ('what your AI team did + today's plan + the 1 thing that needs your click') to the tenant owner. Default OFF (opt-in, 2026-09-07); explicit per-tenant ON required. Independent of the Slack push (autopilot_digest_push_enabled).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  welcome_email_sent: {
    description:
      "Bookkeeping flag — true once the one-time onboarding welcome email has been sent for this tenant. Idempotency guard for the activate route's best-effort welcome email. Default false; not a user-facing preference.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  onboarding_email_sequence_enabled: {
    description:
      "Master switch for the onboarding email sequence (welcome + one channel introduction per day for eight emails over nine days). OFF: activate sends the old one-time welcome and enrols nobody, and the sweep sends nothing. Turning it on only affects workspaces created afterwards.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  preview_ready_email_sent: {
    description:
      "Bookkeeping claim — the ONE 'it's ready' email per workspace: inserted (never overwritten) right before either the 'Zavi finished N actions' email (Free signup previews) or the 'Your growth plan is ready' email goes out (services/growth/ready-email-claim.ts), so whichever is ready first sends and the other skips. Kept after an uncertain send; removed only when the send certainly did not happen. Default false; not a user-facing preference.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  upgrade_actions_ready_email_sent: {
    description:
      "Bookkeeping flag — true once the one-time 'Your N actions are ready' email has been sent after a tenant upgraded and its previewed channels ran for real. Default false; not a user-facing preference.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  results_email_claimed: {
    description:
      "Bookkeeping claim — inserted (never overwritten) by the one sender allowed to tell this workspace its first results: the onboarding day-1 digest OR the 'Your N actions are ready' upgrade email, never both (services/growth/results-email-claim.ts). Kept after an uncertain send; removed only when the send certainly did not happen. Default false; not a user-facing preference.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  signup_preview_real_cards: {
    description:
      "Signup preview runs save their cards, so a new Free workspace can read, copy and mark done the drafts from its first round. Zavi posting or applying a card, redo, scheduling and running again still need the plan. OFF: the run is count-only, as before. Only affects runs started afterwards.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  done_for_you_enabled: {
    description:
      "Free workspaces see \"Have Zavi do this\" on one card in Growth Today, and Zavi carries that card out once on the house (model spend capped at 1,000 credits a run, at most 3 attempts a workspace). OFF: no offer and new starts are refused; runs already started finish.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  first_plan_watch_skip_tenants: {
    description:
      "Workspace ids (JSON array of uuids) the first plan watch and its backfill never start a plan for or page about, e.g. a deletion asked for by email. Workspaces with an in-app account deletion are skipped without being listed. Remove an id once its deletion is processed.",
    type: "json",
    scope: "global",
    defaultValue: ["d52644ab-2d94-47b2-8e33-d35016c5cf41"],
  },
  first_plan_stalled_setup_minutes: {
    description:
      "Minutes a new workspace's setup may sit unfinished before Zavi skips the rest of it and drafts the first growth plan from the website (signups from the last 24 hours only). 0 turns it off. Each takeover is one website research pass, one refunded plan draft and, on Free, the first round's two house-paid previews.",
    type: "number",
    scope: "global",
    defaultValue: 120,
    min: 0,
    max: 1380,
  },
  new_tenant_alert_sent: {
    description:
      "Bookkeeping flag — true once the internal new-tenant summary email has been sent for this tenant. Idempotency guard for the activate / build-start best-effort ops alert. Default false; not a user-facing preference.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  signup_alert_emails_enabled: {
    description:
      "Internal signup emails to NEW_TENANT_ALERT_EMAIL: the new-tenant alert at signup and the 24h follow-up. Default OFF. Other founder activity alerts are unaffected.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  founder_activity_alerts_enabled: {
    description:
      "Global mute for the internal founder activity emails (launch video request, first chat, first channel run, out of credits, feedback, ...). Default ON. Recipient is NEW_TENANT_ALERT_EMAIL.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  founder_alert_events_emailed: {
    description:
      "Founder activity events that are emailed to FOUNDER_ACTIVITY_ALERT_EMAILS, as a JSON array of event keys. Default [\"out_of_credits\", \"plan_upgrade_required\", \"feedback_submitted\"]. Others: launch_video_requested, launch_video_claimed, first_chat_message, teammate_invited, first_channel_run, first_connector, first_approval, website_published.",
    type: "json",
    scope: "global",
    defaultValue: ["out_of_credits", "plan_upgrade_required", "feedback_submitted"],
  },
  founder_alerts_sent: {
    description:
      "Bookkeeping map { event_key: sent_at } so each once-per-tenant founder activity email fires once. Written only by founder-activity-alert.ts; not a user-facing preference.",
    type: "json",
    scope: "per-tenant",
    defaultValue: {},
  },
  signup_attribution: {
    description:
      "First-touch attribution captured at signup ({ utm_*, click_id, referrer_host, landing_path, first_seen_at }). Written once by activate / build-start; empty = not captured. Internal, not a user-facing preference.",
    type: "json",
    scope: "per-tenant",
    defaultValue: {},
  },
  fleet_local_lane_enabled: {
    description:
      "GLOBAL master switch for the run-fleet local lane. Default ON (convenience). The lane is still inert per-tenant: a tenant's heavy work routes 'local' ONLY if its per-tenant local-lane flag is ON, and the Mac pull-worker path additionally requires a tenant-scoped non-revoked mac_worker_token. Master ON + zero per-tenant enables = nothing routes local.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  qa_weekly_execute_enabled: {
    description:
      "Per-tenant kill-switch for QA weekly-execute (Mode B delegated-browser). OFF (default) = qa-weekly-execute worker skips this tenant. ON = browser-operator test runs are enqueued when the qa/weekly.execute.requested event fires (tenant-initiated/manual — no fleet cron since 2026-06-11). Read-only unless qa_weekly_allow_writes. Requires qa.staging_url vault key to be set.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  competitor_intel_weekly_enabled: {
    description:
      "Global default for the Competitor Intel Weekly scan. ON (default) = tenants receive weekly competitor snapshots, and the operator brief is delivered ONLY on a real material change (quiet weeks persist the snapshot but stay silent — no spam). Override OFF per-tenant to skip a tenant entirely.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  material_news_enabled: {
    description:
      "Per-tenant opt-out for proactive material-news alerting. ON (default) = eligible for the brain-scoped 'what materially moved in your world' email (hard cap ≤1/week, anchor-grounded, empty→silent). Override OFF per-tenant to silence it. The global material_news_rollout kill-switch still gates the whole fleet on top of this.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  mention_alerts_enabled: {
    description:
      "Per-tenant opt-in for brand-mention alerts. ON = email the workspace when a tracked brand term is mentioned on a connected channel (Reddit today; X and LinkedIn as soon as each stores mentions). Hard cap ≤1 email / 20h / tenant, no fresh mentions → silent, and every mention is alerted at most once. The global mention_alerts_rollout kill-switch gates the whole fleet on top of this.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  competitor_intel_custom_brands: {
    description:
      "Per-tenant list of operator-named competitor brands the weekly Competitor Intel scan always covers (on top of auto-discovered). Written via the authed custom-brands route (validated/sanitized, ≤20 entries). Default [] = auto-discovery only.",
    type: "json",
    scope: "per-tenant",
    defaultValue: [],
  },
  competitor_intel_rec_decisions: {
    description:
      "Per-tenant operator decisions (act/snooze/dismiss) on weekly Competitor Intel recommended moves, keyed by a normalized rec title so a decision persists across weeks. Written via the authed rec-decisions route (validated, capped). Default {} = no decisions.",
    type: "json",
    scope: "per-tenant",
    defaultValue: {},
  },
  qa_weekly_allow_writes: {
    description:
      "Per-tenant write-mode for QA weekly-execute. OFF (default) = scheduled QA runs are read-only observation (click/fill stripped). ON = browser-operator may fill forms + click on the tenant's configured staging origin ONLY, with the per-run inline-write cap. Enable only on a staging site with disposable test data.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  local_lane_side_effects_allowlist: {
    description:
      "DEPRECATED 2026-06-14 — NO ROUTING EFFECT. The lane router no longer reads this key: expensive non-money work routes to the run-fleet 'local' (laptop) lane BY DEFAULT, gated only by the master switch (fleet_local_lane_enabled) + per-tenant tenant_local_lane.enabled. Retained (default OFF) so the staff settings row + historical audit don't 404; safe to drop in a later cleanup once nothing references the key.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  engineer_runs_local: {
    description:
      "When ON for a tenant, EVERY engineer run — including CONVERSATIONAL slack/chat requests (not just background) — is HANDED to the run-fleet 'local' (laptop) lane by the cloud run-agent worker instead of executing on e2b. Default OFF — this is a high-blast-radius interception in run-agent (the shared all-agent execution path), so it stays INERT until a tenant explicitly opts in. Also requires the master fleet_local_lane_enabled + per-tenant tenant_local_lane.enabled gates. Money-path agents are NEVER handed local. If the laptop never claims, queued-stuck-scan reaps the run after its 15-min expensive window (visible failure + Slack note) — no cloud rescue at this stage. Per-tenant only.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  perfmkt_pulse_enabled: {
    description:
      "Per-tenant off switch for the performance-marketer daily ads pulse (anomaly watcher). ON (default) = the perfmkt-pulse cron runs a cheap non-LLM threshold pre-check and wakes performance-marketer only on a spend/CAC/ROAS/delivery/pixel anomaly. Only fires for tenants with Meta connected. The woken run still respects meta_ads_write_enabled + /approvals — no new spend authority.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  strategist_gate_enabled: {
    description:
      "Kill switch for the growth-lead strategist market-fit gate on performance-marketer create-ad-set proposals. ON (default) = a create is parked behind a growth-lead review before the operator sees it (PR #1504 behavior). OFF = the gate is bypassed and the raw meta_ads.create_ad_set is emitted straight to the operator-approval path (pre-#1504 behavior) — only the strategist review is skipped, spend still requires operator approval. Default ON so this is only an off-ramp; flip OFF (per-tenant or the global row) to disable the gate with no redeploy.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  meta_bid_by_strategy_enabled: {
    description:
      "Meta ad-set create reads the campaign's bid strategy and copies a bid from an ad set in it only when the strategy needs one (bid cap, cost cap, minimum ROAS). OFF = no bid is sent, the old behaviour. Default ON.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  skill_auto_inject_enabled: {
    description:
      "Kill switch for deterministic skill auto-inject. ON (default) = the dispatcher injects the playbook matching a mapped agent's task into the prompt (bypasses the dead self-select step). OFF = no auto-inject, self-select only. Static global playbook text, read-only. Flip OFF (per-tenant or global row) to disable with no redeploy.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  screenshot_artifact_render_enabled: {
    description:
      "When ON, agent browser_screenshot captures are persisted as chat artifacts and rendered inline in the thread. Default OFF; per-tenant opt-in.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  artifact_gallery_enabled: {
    description:
      "When ON, GET /api/run-artifacts lists the tenant's delivered artifacts (decks/reports/PDF/CSV/XLSX) with short-TTL signed preview URLs so they don't vanish into Slack scrollback. Flat tenant-scoped list (no issue-tree grouping). Default OFF — a tenant without an override sees no gallery (endpoint returns enabled:false). Reads are RLS + tenant_id scoped; each preview URL is tenant-prefix-guarded before signing. Per-tenant opt-in.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  browser_portal_allowlist: {
    description:
      "Per-tenant allowlist of browser-navigable origins. When non-empty, the agent's browser may ONLY navigate to these origins (scheme+host exact match); a nav elsewhere is refused. Default [] = no restriction (allow all). Values are full origins, e.g. \"https://app.vendor.com\".",
    type: "json",
    scope: "per-tenant",
    defaultValue: [],
  },
  engineer_audit_weekly_enabled: {
    description:
      "Global default for the Engineer Audit Weekly scan. ON = github-connected tenants inherit a read-only weekly audit of the connected repo (secrets/PII + pricing/billing) reported as findings (never a PR), unless explicitly overridden off.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  engineer_html_preview_enabled: {
    description:
      "When ON, a UX/design-shaped engineer chat ask first emits a static HTML mock of the proposed UI (rendered inline in a locked-down iframe: empty sandbox, no scripts, default-src 'none' CSP) and pauses for the operator to approve/correct BEFORE the expensive e2b build / PR. Default ON (2026-07-13) — a cheap preview turn is far cheaper than the blind build an operator rejects. Per-tenant; a tenant that has EXPLICITLY set this to false stays false (getSetting treats a stored `false` as present, so only UNSET tenants pick up this default).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  approval_pause_resume_enabled: {
    description:
      "Durable approve-and-resume. When ON, an approval-gated decision PAUSES the run (paused_awaiting_approval, slot freed) instead of ending; on approve, the action runs and a continuation run on the SAME thread resumes the agent's reasoning with the outcome injected. ARMED FLEET-WIDE 2026-07-05 per Ravi — slices 0-4 all merged + deployed and the pre-flip checklist is DONE (credit-finalization treats paused as terminal via migration 20260704230000; slack/email/teams completion and the paused render both handle it). Runs pause in production today. Reversible: set the global row false or delete it. NOTE the registry defaultValue below stays false — the live state comes from the app_setting row, not this default, so do not read the default as the current posture. Scope: pauses only CONVERSATIONAL triggers (chat/slack/email/teams) per isInteractiveResumeTrigger; cron/a2a/manual/webhook/handoff runs end-then-dispatch as before. Per-tenant overridable.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  pm_hybrid_surface: {
    description:
      "When ON, the Product Manager operator dashboard renders the Hybrid surface (standup + governance) and enables the needs-you Approve/decline actions (approval-gated — a human two-step-confirms before any PR close / re-dispatch). Default ON for all tenants; global `= false` is the fleet kill-switch, per-tenant override opts a tenant out.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  pm_needs_action_digest: {
    description:
      "When ON, pending pm.needs_action approval decisions from the same pm run are consolidated into ONE Slack digest card (per-item Approve/Reject when ≤15, a full list + batch controls + app link when >15) instead of N separate bubbles. Default OFF — a tenant without an override is byte-identical to the current per-bubble behavior. Per-tenant opt-in; flip the global row to enable fleet-wide.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  engineer_live_preview_enabled: {
    description:
      "When ON, after an engineer run makes a UX-changing diff the changed branch's dev-server is booted in-sandbox and served to the customer through a backend authed proxy (the REAL running app, before/with the PR). Default OFF — a tenant without an override never boots a preview (byte-identical to today). Per-tenant opt-in; flip the global row to enable fleet-wide.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  engineer_site_preview_enabled: {
    description:
      "When ON, the web app can open a no-profile headful Anchor browser on a customer-supplied URL and embed its interactive live view directly in the operator's browser. Default ON — the session carries no customer login and is reaped by the stale-session sweeper; hits none of the four default-OFF gates. Flip OFF (per-tenant or the global row) as an instant kill switch.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  engineer_design_fidelity_gate_enabled: {
    description:
      "When ON, an engineer build that was bound to an APPROVED design mock is blocked from opening a PR if it introduces a native browser control (<input type=\"datetime-local\">, a bare <select>, the default calendar popup) that the mock's design_spec.native_controls did not explicitly bless. Deterministic — reads the diff, no screenshot, no LLM. Catches the class where an operator approves a custom picker and the agent silently ships the browser default. Default ON.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  engineer_shareable_preview_enabled: {
    description:
      "When ON, a Tier-A engineer design mock is also published as a persistent public shareable prototype link (preview.zaviagent.com/<slug>) with Before/After + rationale + live real-PR badge. Generated artifact only (no app boot), leak-scanned fail-closed. Default OFF; flip the global row after dogfood smoke.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  summoned_surfaces_enabled: {
    description:
      "Front door option C: let a Zavi reply mount a domain surface (e.g. the build/PR queue) inline in the reply. Deterministic in-code match on the user's turn; renders the existing per-agent dashboard read with the viewer's own bearer. Presentation only — no new data or authority. Flip OFF to stop mounting surfaces.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  agent_wireframe_enabled: {
    description:
      "Kill switch for the render_wireframe agent tool (report__render_wireframe). ON (default) = any customer-facing agent may generate a clickable HTML wireframe (simulated data) and publish it to a public preview.zaviagent.com/<slug> page with wireframe chrome (no PR badge). Reuses the shareable-prototype spine: fail-closed leak-scan, unguessable slug, sandboxed iframe, tenant-from-run. Flip OFF (per-tenant or global row) to disable with no redeploy.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  agent_deck_enabled: {
    description:
      "Kill switch for the render_deck agent tool's PUBLIC shareable link (report__render_deck). ON (default) — decided by Ravi 2026-08-31 on the Google-Doc \"anyone with the link\" model. The deck is published to an UNAUTHENTICATED preview.zaviagent.com/<slug> page carrying the tenant's REAL business figures, so anyone holding the link can read it without signing in; unlike render_wireframe (simulated data only), that exposure is the accepted posture, not an oversight. Controls are a 128-bit unguessable slug, noindex, 30-day expiry and owner revocation — there is no auth check on read, and the publish-time leak scan matches secret patterns, not PII or business numbers. Agents are required to disclose that the link is public when handing it over. Flip OFF (per-tenant or the global row, no redeploy) and decks deliver as a private, auth-gated landscape PDF artifact only.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  status_reality_grounding: {
    description:
      "When ON, a status agent's pending/open/work-left claim about an anchored ticket/feature is cross-checked against shipped reality (a read-only tenant-scoped git-history + live-code probe); the reply leads with a corrective banner on strong evidence or a verify-first hedge on partial evidence, original text preserved. Deterministic enforcement (no prompt-hardening). Default ON; flip OFF (per-tenant or global row) as an instant kill switch.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_conflict_resolution_enabled: {
    description:
      "Semantic conflict resolution + fact versioning on memory write. When ON, a write with no byte-identical dup detects contradictory existing facts and auto-supersedes the stale one (apply_dream_verdict KEEP_NEW), trust-guarded so a lower-trust note never buries a higher-trust one. DEFAULT FLIPPED TO OFF 2026-07-13 (Ravi) — see below. A tenant can still opt IN with an explicit true override.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  memory_agentic_read_enabled: {
    description:
      "Agentic-read layer for the company brain. When ON, the internal memory server advertises two READ-ONLY tools — memory_list_topics (compact titles+ids topic map; surfaces anchors + high-salience old notes, not just recent) + memory_read (full bodies by id) — so the model can browse + choose context, routing around recall@k + the reranker. Default ON fleet-wide 2026-06-27 (Ravi); a tenant can still opt out with an explicit false override. memory_search is unaffected.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_heartbeat_enabled: {
    description:
      "Company-brain heartbeat — proactive automation proposals. When ON, a daily cron mines this tenant's repeated manual agent invocations and proposes ONE inert automation per day (founder one-click Approve → inserts a tenant_agent_schedules row). Never auto-acts. Default ON fleet-wide 2026-06-30 (Ravi); a tenant can still opt out with an explicit false override (per-tenant consent only — a global enable is rejected). Safe to default-ON: the worker only PROPOSES (approval-gated + never_auto), never fires.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_llm_entity_extract_enabled: {
    description:
      "LLM typed entity + relation extraction on memory write (Mem0g pattern). When ON, each write runs one LLM pass to extract typed person/company/deal entities + relations between them and persists to the same memory_entity/memory_note_entity/memory_relation tables, ADDITIVE to the regex entity path. Default ON fleet-wide 2026-06-27 (Ravi); a tenant can opt out with an explicit false override. Adds one LLM call per write.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_valid_time_enabled: {
    description:
      "Bi-temporal valid-time on memory write. When ON, each write runs one cheap Haiku pass to extract when the fact was true in the world (valid_from/valid_to) — stamped on memory_note, distinct from the system-time superseded lineage — and closes the old note's interval on supersede. No real-world date extractable → columns stay NULL (never guessed). Default ON fleet-wide 2026-06-30 (Ravi); a tenant can still opt out with an explicit false override. Valid-time touches only the opt-in as_of read path, never default recall.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_episode_provenance: {
    description:
      "Work-episode provenance capture (Perplexity-Brain gap P0.1). When ON, each terminal run's episode records connectors_used + candidate_sources_checked (tool + returned opaque ids) + candidate_dead_ends (tool + error code), derived from the already-scrubbed tool_calls previews, and the distilled episodic note renders them. Heuristic 'checked' names by design — not 'held' (needs the deferred evidence aligner). Default ON (2026-07-04) — C14 0-PII verified; per-tenant override can opt out.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  marketplace_intel_enabled: {
    description:
      "Per-tenant switch for Supply & Demand nightly rollups. ON = the cron reads this tenant's own operator database (MongoDB, Postgres or MySQL) read-only and writes weekly location rollups via the service-role-only RPC. Default ON (2026-06-30, Ravi); a tenant only gets rollups once an admin has confirmed its Supply & Demand setup, so ON-for-all is bounded by that confirmation. Per-tenant override can opt out.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  marketplace_rollup_last_run: {
    description:
      "Internal status written by the Supply & Demand rollup after each run: {status, at, code}. Not a switch; do not edit by hand.",
    type: "json",
    scope: "per-tenant",
    defaultValue: {},
  },
  marketplace_intel_dashboard_enabled: {
    description:
      "Per-tenant dashboard gate for Marketplace Intelligence. OFF = hide the marketplace intelligence UI even if rollups exist. Default ON (2026-06-30, Ravi); tenants with no rollup data just see the not-configured empty state. Per-tenant override can opt out.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  bulk_outbound_enabled: {
    description:
      "Per-workspace switch for bulk email to a contact list (email__propose_campaign or outbound__propose_cohort_email + the bulk_outbound.send approval). ON by default; set a per-workspace false to switch one workspace off. A global write is ignored. When OFF the tool refuses and any send in flight is held at its next check. The abuse shutoff sets this to false for a workspace whose send crosses the spam-complaint or hard-bounce threshold.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  bulk_email_send_enabled: {
    description:
      "Zavi's own bulk email sender. Off stops every workspace's Zavi-list sends; email tools still send.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  outbound_basis: {
    description:
      "Per-tenant sending basis for bulk first-party outreach: 'opt_in' (default, conservative — only explicit marketing-opt-in records are eligible) or 'relationship' (existing-relationship records eligible). The cohort resolver filters eligibility on this value. Per-tenant-only — a global write can never change the fleet's basis.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "opt_in",
  },
  critic_family: {
    description:
      "Which AI model family reviews cgo's growth plans (a different family from the agent that wrote them). openai = OpenAI gpt-5.5; glm52 = GLM-5.2 on Fireworks. Takes effect on the next critic call. Default: openai.",
    type: "string",
    scope: "global",
    defaultValue: "openai",
    options: ["openai", "glm52"],
  },
  model_routing_enabled: {
    description:
      "Master switch for cost-first model routing (auto-picks the cheaper Sonnet vs Opus per task). OFF = every agent uses its full default model (higher cost). Default: ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  model_routing_mode: {
    description:
      "shadow = log which model routing WOULD pick, change nothing (use this to preview cost impact). live = actually apply the cheaper pick.",
    type: "string",
    scope: "global",
    defaultValue: "live",
    options: ["shadow", "live"],
  },
  engineer_cost_v2: {
    description:
      "Engineer cost v2 kill switch. ON = the engineer routes small edits to Sonnet 5 and everything else to Opus 5.5, with only high-risk words forcing the deep model. OFF = reverts engineer routing, effort, prompt cuts and step budget to pre-v2 (Sonnet 4.6 / Opus 4.7, old floors), no deploy. Default: ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  engineer_deep_effort: {
    description:
      "SDK effort for engineer runs on Opus 5.5 (engineer cost v2). Higher = more thinking and more cost per run. Default: high.",
    type: "string",
    scope: "global",
    defaultValue: "high",
    options: ["low", "medium", "high", "xhigh", "max"],
  },
  product_build_small_edit_light_model: {
    description:
      "Build-pane small edits (refines the fast path marks small_edit) run the engineer on Sonnet 5.5 instead of Opus 5.5. No step cap applies. Changes edit quality, so it is OFF until an eval proves it. Default: OFF.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  product_build_scaffold_light_model: {
    description:
      "Product-build scaffold runs the engineer on Sonnet 5.5 instead of Opus 5.5. No step cap applies. Changes scaffold quality, so it is OFF until an eval proves it. Default: OFF.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  conductor_enabled: {
    description:
      "Master autonomy switch. OFF = pauses ALL autonomous agent runs (a safe global pause / panic button). Default: ON. (Per-tenant Autopilot opt-in is still required for anything to run.)",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  conductor_repair_enabled: {
    description:
      "Let the system auto-repair stalled or failed runs. OFF = stalled runs are left for manual handling. Default: ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  conductor_owner_only: {
    description:
      "A build is advanced only by the server that started it. A laptop and the deployed server share one database, so without this both tick the same build, re-queue each other's runs and fight over one sandbox. Takes effect ONLY on a local dev backend: a deployed server (production and the development server) always advances every build, whoever started it, whatever this key says. Applies, on a local backend, to the conductor tick (cron sweep and per-run ticks), the queued-run re-send, the stuck-run reaper and the stale-run reaper: each skips a run whose own worker or whose build's owner is another server, and never re-sends a child of a build that is no longer active. Builds started before this setting existed carry no owner and behave as before. Default: ON. OFF = every server advances every build, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  daily_budget_usd: {
    description:
      "Global daily LLM spend cap in USD across the whole fleet — runs are blocked once the day's spend passes this. 0 = uncapped (no limit). Set carefully: too low halts the fleet. (A per-tenant budget override still wins over this global floor.)",
    type: "number",
    scope: "global",
    defaultValue: 0,
    min: 0,
    max: 100000,
  },
  max_code_index_per_tenant_per_day: {
    description:
      "Max code-indexing operations per tenant per day (indexing is pricey). Caps runaway per-tenant cost. Default: 5.",
    type: "number",
    scope: "global",
    defaultValue: 5,
    min: 0,
    max: 1000,
  },
  product_builder_enabled: {
    description:
      "Let the engineer agent start a follow-on product-build PR after a run (expensive). OFF = engineer skips the build step. Default: ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  ugc_video_finish_pass_enabled: {
    description:
      "Edit each 9:16 talking-head AI video after it renders: tightened pauses, captions and the hook title. OFF = deliver the vendor's video unedited.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  media_router_enabled: {
    description:
      "Route customer image/video/voice generation through the media router (fal) and charge credits at cost. OFF = legacy Higgsfield path, no media charge.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  refine_direct_merge_enabled: {
    description:
      "Auto-publish refine runs: direct-merge (push_to_main) into the provisioned app's production repo so a customer's change goes live automatically. TRUE (default) = push_to_main + deploy gate that verifies the live deploy. FALSE = per-tenant kill-switch: refine changes park as a branch + PR for human merge; the conductor run terminates at pr_ready.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_text_edit_direct: {
    description:
      "Site text tool, direct apply: a text change sent from a site's preview is written straight into the site's code (an exact, single match of the old words, checked to change only copy), committed to the site repo and shown in the preview in seconds, with no AI run. A change it cannot place exactly falls back to the AI edit. TRUE (default). FALSE = per-tenant kill switch back to sending every text change as an AI edit.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_design_edit_direct: {
    description:
      "Instant design edits: from a site's preview the founder changes the site's colours, fonts and corners, a section's layout, background or place on the page, or swaps a photo for one from a public https address, and the platform writes the change straight into the site's code (theme.css, the page's section JSX, new webp files under public/images), commits it to the site repo and shows it in the preview, with no AI run and no credits. A change it cannot place exactly is refused with a pointer to the chat. TRUE (default). FALSE = per-tenant kill switch: these controls answer 'ask in the chat'.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_image_ai_edit: {
    description:
      "AI photo edits in the site editor: replace a photo with a new one from a description, or edit the current photo with an instruction (a whole-photo edit through the media router's image.edit; the photo goes to the image vendor through a 15-minute signed link that is deleted afterwards). Each one CHARGES CREDITS at the vendor's real cost through the media charge path (Ravi 2026-10-07): the wallet is checked before the vendor is called, and the charge is taken only after the photo is on the site, once per commit. Paid edits do not use the build photos' free 12-per-site cap. TRUE (default). FALSE = per-tenant kill switch (a photo from a link still works).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_image_ai_mask: {
    description:
      "Partial AI photo edits in the site editor: the founder brushes over the part of a photo to change, the whole photo is edited through the same image.edit path as site_image_ai_edit, and only the brushed area is composited back onto the original, so everything outside the mask is kept from the original (the finished photo is saved once more as webp, like every edit). Same wallet check and same once-per-commit charge as site_image_ai_edit. TRUE (default). FALSE = per-tenant kill switch: no brush, whole-photo edits only.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_preview_comments: {
    description:
      "Pinned comment threads on a site's preview: a workspace member pins a comment to a page element, teammates reply and @mention each other (mentioned members get one email), a thread can be resolved or sent to the agent as a change request. Threads are visible only to members of the site's tenant. TRUE (default). FALSE = per-tenant kill switch: no Comment tool and the comment routes answer feature_disabled.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_figma_handoff: {
    description:
      "Build from a Figma frame: in the Build composer the founder pastes a figma.com design link, the backend exports that frame as a PNG with the tenant's own Figma token and hands it to the build as a required reference image (the same path as attached idea images). If the requested frame cannot be exported or stored, build start fails so it never silently omits the reference. TRUE (default). FALSE = per-tenant kill switch: no Figma row and build-start rejects a sent frame.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },

  build_live_edit_enabled: {
    description:
      "Build live edit: a refine edits a draft branch (zavi/draft) of the provisioned app and the Build preview frames the sandbox dev server, so the change shows in seconds. Nothing reaches the live app until the founder presses Publish, which fast-forwards main to the draft. The raw sandbox preview URL is not login-protected. TRUE (default). FALSE = per-tenant kill switch back to today's refine flow (auto-publish or PR, per refine_direct_merge_enabled).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_graduation_auto: {
    description:
      "Site graduation auto: when a site on the shared site database passes the records, bytes or writes-per-minute threshold below, Zavi moves it to its own database project automatically (a paid project per site; its writes pause for the few minutes of the move, then members sign in again with the same password). FALSE (default) = ops are alerted and nothing moves.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  site_graduation_records_threshold: {
    description: "Site graduation: records on one pooled site at which it is due to move to its own database (alert; auto-move only with site_graduation_auto).",
    type: "number",
    scope: "global",
    defaultValue: 250000,
    min: 1000,
    max: 100000000,
  },
  site_graduation_bytes_threshold: {
    description: "Site graduation: stored record bytes on one pooled site at which it is due to move to its own database (alert; auto-move only with site_graduation_auto).",
    type: "number",
    scope: "global",
    defaultValue: 1073741824,
    min: 1000000,
    max: 1099511627776,
  },
  site_graduation_writes_per_min_threshold: {
    description: "Site graduation: writes in one minute on one pooled site at which it is due to move to its own database (alert; auto-move only with site_graduation_auto). The shard's own per-site quota (600 writes/min by default) refuses writes past it, so this sits just below.",
    type: "number",
    scope: "global",
    defaultValue: 500,
    min: 10,
    max: 10000000,
  },
  site_graduation_grace_days: {
    description: "Site graduation: days the frozen copy of a moved site is kept on the shared database before it is deleted.",
    type: "number",
    scope: "global",
    defaultValue: 7,
    min: 0,
    max: 90,
  },
  site_shard_auto_provision: {
    description:
      "Shared site database auto-provisioning: when the open shards' headroom drops below site_shard_auto_threshold (or no shard is open), Zavi creates the next shared database (a paid Supabase project, about $10/month) on its own, at most site_shard_auto_max_per_day a day, and alerts ops every time. FALSE = ops are alerted and nothing is created (staff can still create one from the admin console).",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  site_shard_auto_threshold: {
    description: "Shared site database auto-provisioning: create the next shard when the open shards' remaining headroom (measured load against each shard's fill ratio, worst dimension: sites, records, bytes, auth users, sessions, email, requests) falls below this percent.",
    type: "number",
    scope: "global",
    defaultValue: 20,
    min: 1,
    max: 90,
  },
  site_shard_auto_max_per_day: {
    description: "Shared site database auto-provisioning: the most NEW shards (paid projects) created per UTC day, automatic and staff together. Hard-capped at 10; staff can override for one shard with an audited flag.",
    type: "number",
    scope: "global",
    defaultValue: 10,
    min: 0,
    max: 10,
  },
  site_shard_auto_region: {
    description: "Shared site database auto-provisioning: the Supabase region new shards are created in.",
    type: "string",
    scope: "global",
    defaultValue: "us-west-1",
    options: ["us-west-1", "us-west-2", "us-east-1", "us-east-2", "ca-central-1", "eu-west-1", "eu-west-2", "eu-central-1", "ap-south-1", "ap-southeast-1", "ap-northeast-1", "sa-east-1"],
  },
  site_shard_auto_dry_run: {
    description: "Shared site database auto-provisioning dry run: TRUE = the hourly capacity check logs and alerts what it WOULD create, and creates nothing.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  site_idle_pause_enabled: {
    description:
      "Fast website builds: pause the Supabase project of a site nobody visited or edited for 30 days, show visitors a 'waking up' page, and email the owner. FALSE (default): the daily sweep does nothing, because projects in a paid Supabase org cannot be paused. Turn on only for a free-plan org. Even when TRUE, a pause Supabase refuses leaves the site live, with no waking page and no email.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  build_replay_fixture: {
    description:
      "Dev only. Replays a saved build instead of calling the AI for the spec, scaffold and build steps, so the rest of the pipeline (sandbox, push, database, deploy, smoke check) runs for real with no model spend. Per tenant only, ignored by any production or staging backend. 'off' runs the real model.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "off",
    options: ["off", "db-app"],
  },
  fast_build_turn_cap: {
    description: "Fast website builds: the turn cap of the single AI build pass.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 60,
    min: 10,
    max: 200,
  },
  fast_build_repair_attempts: {
    description: "Fast website builds: how many targeted fix passes run after a failed gate before the build stops.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 1,
    min: 0,
    max: 3,
  },
  build_prompt_cache_5m: {
    description:
      "Website builds and edits (runs carrying build_conductor_run_id, and refine runs) write the 5-minute prompt cache instead of the fleet's 1-hour one (prompt-cache-ttl.ts). A build run's turns are seconds apart, so the 5m entry stays warm, and a 5m write costs 1.25x input against 2x for 1h; cache writes were about half of a build's cost. TRUE (default, Ravi 2026-10-07). FALSE = builds and edits go back to the 1h cache, no deploy needed. Every other agent keeps 1h either way.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_vision_review_mode: {
    description:
      "Fast website builds: what the review before publish does (screenshots at desktop and phone width, plus the page check for repeated sections and copied pages). The SITE_GATE_VISION_REVIEW env flag stays the master switch (on unless 0). 'correct' (default since 2026-10-07, Ravi) runs at most ONE fix pass per deploy when the site passed its checks but the review found a high-severity, high-confidence visible defect (never a preference). That pass is FREE: Zavi pays (claim_site_vision_fix_status + the credit-trigger waiver, migration 20261021094500), it costs the founder no credits and nothing against the build budget, and if it cannot be reserved the site publishes without it. It does not use up the fast_build_repair_attempts passes; its turn cap is site_vision_fix_turn_cap; its outcome is recorded on the deploy node (site_vision_fix) and in praxis_logs (site_vision.fix_outcome). 'observe' records the findings and changes nothing. 'off' takes no screenshots and runs no page check.",
    type: "string",
    scope: "per-tenant",
    defaultValue: "correct",
    options: ["off", "observe", "correct"],
  },
  site_vision_fix_turn_cap: {
    description: "Fast website builds: the turn cap of the one screenshot-review fix pass (site_vision_review_mode 'correct'), which bounds its time and cost.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 20,
    min: 5,
    max: 60,
  },
  site_fast_edit_node: {
    description:
      "Fast website builds: a small edit to a new-flow site runs one short Vite edit pass (edit only the files it names, no install, build or typecheck, no new files, no package.json or migration change) under site_fast_edit_turn_cap, with a low cost estimate. A fix pass after a failed check keeps the normal refine prompt. TRUE (default). FALSE = small edits use the full refine prompt and estimate.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_edit_auto_route: {
    description:
      "Size-routed site edits: a change typed in a site's chat or Build pane that is clearly a small change to something already on the page (its words, colour, font, size or link) runs the short fast edit pass (site_fast_edit_node) instead of the full change pass; anything else (a new page, section or form, several asks at once) keeps the full pass, which may create files. A fast pass that answers instead of changing code is re-run once as a full pass. TRUE (default). FALSE = every typed change runs the full pass, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_design_adherence_report: {
    description:
      "Site design checks: after a site build or change, before it is pushed, the changed files are checked against the site's design system and the result is logged (site_design_adherence): raw colours that skip the theme tokens, font changes outside theme.css, repeated one-off spacing, and structure changed outside what the founder asked for (sections, navigation links, images). Reporting only: the files and the push are never changed or blocked, and no model is called. TRUE (default). FALSE = no check and no log.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_fast_edit_turn_cap: {
    description: "Fast website builds: the turn cap of a small-edit pass on a new-flow site (site_fast_edit_node).",
    type: "number",
    scope: "per-tenant",
    defaultValue: 15,
    min: 5,
    max: 60,
  },
  site_deploy_skip_unchanged_migrations: {
    description:
      "Fast website builds: when a new-flow site is already live and the change since its live commit touches nothing under supabase/migrations, the publish skips listing and re-applying migrations. The database security check still runs. TRUE (default). FALSE = every publish lists and applies every migration.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_light_gate_copy_edits: {
    description:
      "Fast website builds: a publish whose real git change since the live commit only modifies .css, .tsx, .jsx or index.html files, and in the .tsx/.jsx/.html files changes only visible text and the className, alt, title, placeholder, aria-label or content values, takes a light check instead of the owner sign-in and browser smoke run: the build passes, the preview link and home page answer, every script and stylesheet loads, and every new text or class appears in the published bundle. A change to an og:image, og:url or twitter:image value is not light, and neither is a change to any .css file or any className / class value, because the full gate's phone width check must run on it, except a colour-only change that site_light_gate_color_edits lets through. Before the light check, the lines the change adds are searched for a signed Zavi storage link (site_images_downloaded). A failed light check is repaired and never published, except that a light check that cannot reach the preview (the preview link or home page did not answer, answered the wrong status, or timed out) runs the full check instead. Any other change, or a site with no live commit, takes the full check. TRUE (default). FALSE = every publish takes the full check.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_activate_kicks_conductor: {
    description:
      "Fast website builds: when a new-flow site's publish is switched live, the build run that asked for it is woken at once instead of waiting for its next scheduled check. TRUE (default). FALSE = the run notices on its next check (up to about 90 seconds later).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_edit_timing_log: {
    description:
      "Fast website builds: records how long a new-flow site edit takes. A site change stamps when it was asked for, each publish logs a site_deploy_timing row (migrations, build, light or full check, switch-live times) and a finished change logs a site_edit_timing row with the time from request to live. TRUE (default). FALSE = none of these are recorded.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_smoke_gate: {
    description:
      "Build smoke gate: after a build deploys, the acceptance battery runs against the live URL in enforce mode (unless BUILD_ACCEPTANCE_GATE_MODE sets a mode) and also calls every /api route the app's own pages use, so a site whose booking or data API returns a server error is repaired or failed instead of reported ready. A signup route that answers 5xx or redirects with error=server also fails the gate, so a site nobody can sign up to is never called ready. A booking site's availability route must not 5xx; the first product build also books one real test slot when build_booking_smoke is on (default) and, when the site has a sign-up page, signs up a throwaway zavi-smoke-<run>@zavi.invalid user and requires /admin to answer without a server error with that session, once per build run; a product-build push whose SQL queries a table scripts/migrate.mjs never creates is refused; the build page does not say 'Your app is ready' until the live gate passes. Env shadow mode no longer lets these smoke checks through. TRUE (default). FALSE = the gate follows BUILD_ACCEPTANCE_GATE_MODE alone, does not probe api routes, and a failing signup stays an inconclusive pass.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_booking_smoke: {
    description:
      "Build booking smoke: on the first product build only (never a refine), when the smoke gate finds a booking flow on the live site it POSTs one real test booking tagged 'Zavi smoke test' (no phone) and fails the gate if the site answers 5xx, so a site is never called ready while nobody can book. At most once per build run, including repair re-probes. The booking is deleted when the site allows it: DELETE is only called with the id the booking response returned, so on a site with no delete route it stays, and the owner may get one booking email or SMS for it. TRUE (default). FALSE = the gate checks the availability route only and never books.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_auto_site_owner: {
    description:
      "Build auto site owner: when a new build (not a refine) goes live and the site has a sign-up page and the roles schema, Zavi pre-registers the workspace owner's Zavi email as the site's admin. It mints a one-time admin invite bound to that email (7 days, stored only as a hash, kept revoked until the email is sent) and puts a one-click \"Log in to your admin\" magic link plus the site's /admin address in the \"is live\" email. The link opens a login page on the site where the owner presses one button; that signs them in as the admin account for that email, with no sign-up step, and only that email's account can use it. The Build ready card says \"Log in to your admin at <site>/admin\" once that invite is active or used, with a resend button that mails a fresh link (at most one per 5 minutes) and revokes every earlier unused emailed admin link. TRUE (default). FALSE = the email carries only the live URL, the ready card has no admin line or resend button, and no invite is written.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_build_waits_for_look: {
    description:
      "Site build waits for the website choice: a new website's first build started from the web or the mobile app shows the offered websites and waits for the founder to pick one and press Build, with a countdown on the picker. With no pick 60 seconds after the build parked (LOOK_AUTO_START_MS), the server saves the recommended website and starts the build by itself, also when the tab is closed. Setup (repo, starter, brief, websites) runs at once; a choice starts the build within seconds, and a later choice during the first build restyles it for free. A parked build the server could not start ends after 30 minutes (LOOK_PARK_EXPIRY_MS) as waiting for your pick timed out and frees the build slot. A site with fewer than two websites to choose from never waits. The wait holds and charges no credits. First builds started from the web or the mobile app wait (both show the picker); refines, republishes, Slack and chat tools never wait. TRUE (default). FALSE = the first build starts at once in the recommended website and the founder may switch while it runs.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_build_feedback_carryover: {
    description:
      "Build feedback that shapes the next change: when a founder gives a site's build or change a thumbs down and ticks what was off (look, layout, wrong words, missing section, broken, slow), the next change to that same site is told, in at most three fixed sentences, to avoid it. Only the ticked reasons travel, never the free-text comment, and nothing is added for a site with no thumbs down. TRUE (default). FALSE = per-tenant kill switch: ratings are measured for staff only.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_look_industry_rules: {
    description:
      "Site look industry rules: after a new website's design brief is made, Zavi checks its recommended look against the kind of business the idea describes, in code. A gym, fitness, CrossFit, boxing, martial arts or bootcamp site must have a dark or high-contrast palette with an energetic primary colour (red through lime, never a low-saturation or corporate blue), a strong heading font (Bricolage Grotesque, Archivo, Space Grotesk or Outfit) and the bold layout; any part that breaks the rule takes the Midnight bold look's colours, fonts or layout, and parts that already fit are kept. Any other business that is not software, professional services, finance or legal whose brief came back as the generic look (light background, blue or indigo primary, Inter / Plus Jakarta Sans) takes the colours and fonts of the theme preset that best fits the idea, only when that preset is made for this kind of business. A look the idea itself describes, the colours it names, reference images and a starting template are never changed. TRUE (default). FALSE = kill switch: the recommended look is the design brief's own palette, fonts and layout, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_site_offline_status: {
    description:
      "Build site offline status: before the product calls a built site Live (the Settings > Domains badge, the Publish popover and the Build ready card), Zavi loads the site's home page, and when the host answers 503 \"This service has been suspended\" it shows the site as Offline instead of Live, with no live link on the ready card. The check is cached for 60 seconds per site. TRUE (default). FALSE = the stored hosting and domain status decides Live, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_domains_wait_for_build: {
    description:
      "Build Domains waits for the build: the built-in address (Settings > Domains and the Publish popover) says \"Not live yet\" instead of Live while the latest fresh build has not shipped (still running, failed or cancelled), because that build put the starter page back on the address. Refines do not count, and new-flow site builds do not touch this address. TRUE (default). FALSE = the address reads Live as soon as its DNS is verified, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_live_announcement: {
    description:
      "Build live announcement: when a build's site is live, the Build ready card says \"Your site is live at <address>\" with the clickable address and \"Open site\" / \"Open admin\" buttons, and a founder watching the build gets a \"Your site is live\" toast with the address the moment it goes live. TRUE (default). FALSE = the ready card shows only \"Your app is ready\" and no toast, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_edit_change_summary: {
    description:
      "Build edit change summary: when a chat edit to a built site goes live, its reply says in plain words what changed (the engineer's customer summary, else the change's commit title without a \"feat:\"-style prefix), instead of the bare \"Live on your app\" line. A line that names code files, repos or other internal words is never shown. TRUE (default). FALSE = the reply shows only \"Live on your app\", as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_edit_change_summary_fallback: {
    description:
      "Build edit change summary fallback: when a chat edit to a built site goes live and neither the engineer's customer summary nor the commit title gives a plain line (both missing, or both carry code files, repos or other internal words), the reply says what changed from the files the change touched, in plain words such as \"Updated your home page\", \"Updated your site's look\" or \"Added a new pricing page and updated your header\", never a file name. When none of the files says what part of the site it is, the reply says \"Updated your site\". Only applies while build_edit_change_summary is on. TRUE (default). FALSE = such an edit's reply is the bare \"Live on your app\", as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_light_gate_color_edits: {
    description:
      "Fast website builds: a live-site edit whose style change is colour only takes the light check (site_light_gate_copy_edits) instead of the full gate, so a colour edit goes live in about a minute. Colour only means every changed .css declaration differs only in its colour values (hex, rgb/hsl and the other colour functions, or named colours) on a colour property such as color, background, border or box-shadow, every changed CSS custom property holds a colour (or an hsl channel triple like 221 83% 53%) on both sides, every changed @apply list and every changed className / class value only swaps a Tailwind colour utility for another of the same kind and variant (bg-red-500 to bg-blue-600, hover:text-white to hover:text-slate-900), and no selector, at-rule or other value changes. A class swap that adds, drops or changes anything else (flex, grid, hidden, w-, p-, text-lg) still takes the full gate with its phone width check. Only applies while site_light_gate_copy_edits is on. TRUE (default). FALSE = every .css or class change takes the full gate, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_edit_undo: {
    description:
      "Build edit undo: the newest chat edit that went live on a built site shows an \"Undo this change\" button on its reply. Pressing it reverts that edit's commit and republishes the site, and an \"Undid the last change\" reply appears. Only the newest live edit can be undone, and the button hides once a newer edit, build or undo exists. Only owners and admins get the button and the route. The server refuses while a change or build is running, when the app changed after the edit, or when another undo of it is in flight; it resets the preview draft to the undone state and says so when the live site did not republish. TRUE (default). FALSE = no undoable flag on the edit feed and no button, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_repo_follows_app: {
    description:
      "Build repo follows the app: when a new build gets its own Zavi-made GitHub repo, the workspace's Zavi-made GitHub connection switches to that repo, so the chat box repo chip, the repo picker and chat edits with no repo named all use the current app's repo instead of the previous app's. A GitHub account the user connected themselves is never changed. TRUE (default). FALSE = the connection keeps the first build's repo, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_site_own_name: {
    description:
      "Each site has its own name: a new website build (new flow) keeps a display name for the site (the name the founder gives, else a product name they typed, else a short brand name Zavi picks from the idea, else the business the idea is for). The site's address and GitHub repo are built from that name, and the build page title, the website header, Your sites and Recent show it instead of the workspace name, e.g. Paws & Suds at paws-suds-<id>.zaviagent.com in a workspace called Apna Tutor. TRUE (default). FALSE = no stored name and no model call; the address is named from the idea's words alone, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_site_keeps_own_repo: {
    description:
      "Each site keeps its own GitHub repo: building another site no longer switches the workspace's Zavi-made GitHub connection to the newest site's repo. The chat box repo chip shows the open build's repo on a build page; on Home it shows the only site's repo, and no repo at all when the workspace has two or more sites. An engineer chat that names a site's repo works in that site. A GitHub account the user connected themselves is never changed. TRUE (default). FALSE = the connection follows the newest build and the chip always shows the workspace repo, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_site_list_details: {
    description:
      "Your sites and Recent say which site is which: each site row is titled with the site's name (else the build title), and every coloured dot in Recent carries a label on hover saying what it means (building, ready, new reply, needs attention). TRUE (default). FALSE = rows use the build title and the dots have no visible label, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_live_email_only_if_away: {
    description:
      "The \"your site is live\" email goes out only the first time a build goes live, and only when the founder is not watching the build (no build page open and visible in the last 2 minutes). Chat edits, small edits and undo republishes never email, and a new-flow site is emailed at most once. An old-flow first build whose email carries the owner admin login still sends. TRUE (default). FALSE = every finished build, edit and republish emails the owner, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_progress_moves_in_stage: {
    description:
      "The build progress bar moves inside a long step: the build-status feed sends each step's expected length, so a running step fills its share of the bar with time instead of sitting at half, never reaching the next step's share until that step starts and never moving backwards on a retry. TRUE (default). FALSE = a running step counts as half its share, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_visitor_safe_seed: {
    description:
      "Build visitor-safe placeholder: the page a new app's address shows before the built site replaces it says \"Coming soon. This site is being built.\" instead of the developer starter text (\"Edit app/page.tsx\") and the \"Database not configured yet\" pill. The deploy check still recognises it as the placeholder, so a build is never called live while it shows. TRUE (default). FALSE = the old developer starter page.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_publish_waits_for_app: {
    description:
      "Build Publish waits for the app: while a build has nothing to publish yet (no app address, or only the temporary build preview mid-build), the top-bar Publish button is switched off and says why on hover or keyboard focus, and the address bar shows the site's planned address (or \"Not live yet\") instead of an endless grey placeholder. TRUE (default). FALSE = Publish is always clickable and the address bar shows the grey placeholder, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_publish_on_request: {
    description:
      "Build publishes on request: a new site build ends when its preview is ready and nothing goes to the site's address on its own. The build card shows two steps (setting up, building), the site's address shows a \"not published yet\" page, and the top-bar Publish button is what publishes: it runs the same checks and switches the address live. Every chat edit and undo also stops at the preview, on a site already live too: the live address keeps the last published version, the Publish popover lists the changes ready to publish, and Publish puts them live. TRUE (default). FALSE = a new build publishes to its address automatically as its third step, and each edit or undo goes live by itself, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_chat_thread_follows_build: {
    description:
      "One conversation per build: the chat a founder has on a build is saved against that build on the server, so reopening the build (its link, Recent or Your sites, on any device) reopens the same conversation, and that chat no longer shows as a separate row in Recent (it lives under its build). TRUE (default). FALSE = the build chat is remembered only in the open tab, and a question asked mid-build shows as its own Recent row, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_recent_rows_stable: {
    description:
      "Recent stays still while you watch: rows keep their order by when they were created or last written to by you, not by every streaming reply; two rows with the same title get the site name or date added so they can be told apart; and the yellow dot means only a build in progress, never an ordinary chat reply being written. TRUE (default). FALSE = rows reorder on any activity, identical titles stay identical and a streaming chat reply shows the yellow dot, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_mobile_actions: {
    description:
      "Build actions on a phone: below the desktop breakpoint the build view gets a compact actions menu in its header, on both the chat and the app pane, with Preview, Publish, open or copy the live address, App settings, Domains and Export to GitHub, so none of them is clipped off a narrow screen. TRUE (default). FALSE = on a phone those controls sit only in the app pane's bar, where the right-hand ones can be cut off, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_old_flow_one_site_guard: {
    description:
      "Old-pipeline build history: Your sites shows earlier old-pipeline builds that a newer one replaced as \"Replaced by a newer build\" instead of Ready. TRUE (default). FALSE = every finished old-pipeline build shows Ready, as before. (New builds never take the old pipeline, so this no longer refuses or replaces anything.)",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  home_chips_wrap_mobile: {
    description:
      "Suggestion chips readable on a phone: on a narrow screen (639px and below) the welcome's suggestion chips on Home and Build wrap onto as many lines as they need, each with its full label, instead of one drifting row whose edges fade out and cut a label mid-word. Wider screens keep the drifting row. TRUE (default). FALSE = the drifting single row at every width, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  brainstorm_always_build: {
    description:
      "Brainstorm always builds: the pre-signup 'Brainstorm it' chat treats every idea, a simple website included, as something Zavi builds. It asks 2-3 clarifying questions and never tells the visitor to use Squarespace, Wix or another platform, or calls Zavi the wrong tool. A reply that does is retried once, then replaced with a plain build question, and the research opening line is checked the same way. TRUE (default). FALSE = the old brainstorm prompts with no check.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  brainstorm_build_brief: {
    description:
      "Brainstorm build brief: 'Use this idea' in the pre-signup 'Brainstorm it' chat always hands back a build request in the visitor's own voice, never a note about the conversation or advice to use another platform. A brief that reads like a memo or a redirect is retried once, then replaced with the visitor's own words as a build request. TRUE (default). FALSE = the old summarize prompt with no check.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_signup_lands_on_build: {
    description:
      "Build first after signup: while the welcome setup is unfinished, the Build page, the Build nav row and build rows in Recent stay open instead of bouncing to Growth Strategy, so a founder who signed up with a site idea lands on the build that is running. The welcome setup shows as a dismissible panel on the build view. TRUE (default). FALSE = the setup locks every page except Growth Strategy, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  setup_skip_no_confirm: {
    description:
      "Welcome setup's \"Skip setup, take me in\" goes straight into the workspace with no \"Skip setup for now?\" dialog. The dialog still shows when skipping would throw away something the founder typed on the polish step and has not saved (a typed field, a competitor being typed). Since #4248 the web always skips this way and no longer reads this setting; FALSE has no effect.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  home_build_website_cta: {
    description:
      "Home page build door: under the hero's website box, \"Create your website\" is a full-size outlined button (and the same in the closing call to action) that opens /start on the \"What's your idea?\" step, instead of a small underlined link. The main box still starts the growth flow. TRUE (default). FALSE = the small underlined link, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  cookie_banner_clear_of_composer: {
    description:
      "Cookie banner clear of the composer: inside the workspace (/workspace and its pages) the cookie banner for a visitor who has not chosen yet sits at the top of the screen (top right from tablet width up) instead of the bottom left, so it never covers the chat or build box and its send button. Accept, Reject, Manage preferences and Close are unchanged, and every other page keeps the bottom banner. TRUE (default). FALSE = the bottom-left banner everywhere, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  setup_strategy_one_state: {
    description:
      "Welcome setup tells one story about the growth strategy: while the setup draft runs, the Growth page and Zavi in the chat both say it is building (the page re-reads the setup every 10 seconds), and both switch to ready or failed on the same answer. The skip dialogs stop promising to start from a website when none is on file. With no goal yet, the Growth page's big headline asks for a goal and neither it nor the needs panel shows a count of actions waiting for an OK. TRUE (default). FALSE = the page and the chat keep their own separate checks, the skip dialogs keep the website wording, and the headline leads with the waiting count even with no goal, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_website_framing: {
    description:
      "Website path speaks website: a visitor who came to build a site sees website wording instead of growth-teammate wording. The signup side panel after 'Sign up to build', the loader while the new workspace is made, and the Build chat's example prompts and starter chips all talk about the site. TRUE (default). FALSE = the growth wording on every one of those surfaces, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_preview_safe_verify: {
    description:
      "During a first build, the \"Building the interface\" stage verifies its work the same way the scaffold stage does: it builds a copy in /tmp instead of running next build inside the repo the live preview serves, so the preview the founder watches never turns into a \"Cannot find module\" server error or an unstyled page. TRUE (default). FALSE = the build stage runs npm run build inside the served repo, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_flags_fail_to_default: {
    description:
      "Build and website switches fail to their default: when the public build-framing read cannot load one of its switches (website wording, idea examples, idea attach, the named chat pop-up, Your sites first, the home build button, the cookie banner clear of the composer), that switch uses its own default (on) instead of off, so a settings outage never brings back the old wording, \"Zavi finished\" pop-up, cookie banner position or home link. The web app does the same when the read fails or takes longer than 4 seconds. TRUE (default). FALSE = a failed read turns that switch off, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_chat_toast_named: {
    description:
      "The pop-up that appears when a Zavi chat answer lands while the founder is looking at something else says it is a chat reply and names the chat (\"Zavi replied in chat\" with the chat's title and an Open chat button), so it can no longer be read as the website build being finished. TRUE (default). FALSE = the old \"Zavi finished / Ready for you to review\" pop-up with a Review button.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_nav_opens_site_list: {
    description:
      "Clicking Build in the sidebar opens the \"Your sites\" list (every build with its status, newest first, and a New site button) instead of dropping the founder into whichever build is running. New build still opens the empty build box. TRUE (default). FALSE = the Build nav jumps straight into the current build, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_idea_examples: {
    description:
      "The \"What's your idea?\" page on /start helps a visitor start: while the box is empty it shows a row of example website ideas that fill the box on click, and when the typed idea is too short to send it says so under the box instead of leaving the button silently greyed out. TRUE (default). FALSE = a blank box and a silently disabled button, as before.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_idea_attach: {
    description:
      "The \"What's your idea?\" page on /start lets a visitor attach up to 3 reference images (png, jpeg or webp, 5 MB each) to the idea. The images are kept in the browser through signup, validated and stored when the build starts, and handed to the spec and code stages as reference images. TRUE (default). FALSE = no attach control, and build-start ignores any images sent.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  build_zavi_repo_counts_as_github: {
    description:
      "A chat about a site Zavi built (its repo is the chat's repo, or the workspace's default repo) never asks the founder to connect GitHub: the engineer's connect gate and the Connect card both treat the repo Zavi provisioned as connected, and the model is told to work on that repo instead of asking whether a codebase exists. TRUE (default). FALSE = a workspace that also runs its own external site is asked to connect GitHub even for the Zavi-built site, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  setup_coding_prompt_tucked: {
    description:
      "Welcome setup step 1 keeps the Claude Code / Codex prompt folded away behind a plain \"Built your product with a coding tool?\" link, closed by default, so a founder with no code project (a bakery owner building a site) is never asked to run a prompt over CLAUDE.md and git log. TRUE (default). FALSE = the prompt block shows open with its Copy button, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  build_progress_shows_retries: {
    description:
      "Build progress shows retries: when a build step failed and Zavi runs it again, the Build step list and the progress screen say so (\"Retrying app structure, attempt 2\") instead of silently staying on the same step. TRUE (default). FALSE = the step list and progress screen show no retry, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_badge_reserves_space: {
    description:
      "Made with Zavi badge never covers the site: on a built site that shows the badge, the badge is smaller and an empty strip the badge's height is added at the bottom of the page, so the last buttons and fields (a booking day picker, a form's submit) can always scroll clear of it. TRUE (default). FALSE = the larger badge floats over the page with no space kept for it, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_no_sideways_scroll: {
    description:
      "Built sites never scroll sideways on a phone: the new-flow site build prompt requires every page to fit a 375px-wide screen. The site gate checks phone width on every deploy whatever this key says, so a live-site edit that changes a .css file or a className / class value skips the light check (site_light_gate_copy_edits) and takes the full gate, unless the change only swaps colours (site_light_gate_color_edits). TRUE (default). FALSE = no width rule in the new-flow prompt.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_meta_and_404: {
    description:
      "Built sites are named and branded: both site build prompts require a real page title, meta description, og:title, og:description, og:type, og:url when the address is known, twitter:card, a simple favicon in the brand colour and a branded \"page not found\" page with a link home. The site check runs on a site's first build only (new flow: the site has never gone live; old flow: the build is not a refine), so an edit to an existing site is never sent back for page details it already had. On the new flow it sends a first build back when index.html has no title, kept the starter title \"New site\", has no meta description, or kept the starter description; on the old flow it sends a first build back when the home page kept the starter title \"Your Company\" or the starter description (a missing description is not checked there). TRUE (default). FALSE = no such prompt rule and only the old \"Your Company\" title check, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_images_downloaded: {
    description:
      "Founder images are copied into the site: the new-flow site build prompt tells the builder to download each reference image the founder attached into the site's repo and use the local copy, never the 7-day signed link, and the new-flow site check sends a build back for a fix when the site's code still points at a signed Zavi storage link. A first build is searched in full; a later publish of a live site searches only the lines that publish adds, so an older link already in the code never blocks an unrelated edit. TRUE (default). FALSE = the prompt lists the links with no download rule and nothing checks for them, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_images: {
    description:
      "Website builds and edits get photos and icons: the builder has an add_site_images tool that generates up to 4 photos per call (at most 6 new ones per build and 12 per site; a photo already in the repo is reused free) with the same image models as the image tools, converts them to webp at two widths and saves them in the site's own repo under public/images/ with alt text, listed in public/images/zavi-images.json. Zavi pays the image cost and logs it (praxis_logs source site-images); the customer is not charged for it. The full site check on a first publish, or on any site with that list, opens the home page and fails when one of its own images (same address) is broken, and, when the list names at least one generated image, when none of those shows on the home page. Images from other hosts are not checked. If image generation is down the site still builds without photos and the check does not ask for one. TRUE (default). FALSE = no image tool and no image check, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_booking_journey_required: {
    description:
      "A booking site must prove booking works before it first goes live (new-flow sites). A site counts as a booking site when the build idea mentions bookings, appointments or reservations, or zavi-site.json has a route or journey path like /book, /booking, /appointments or /reserve, or a collection named bookings, appointments or reservations. The site build prompt asks such a site for a smoke journey named book with writes: true, and the site check on the site's first publish fails when zavi-site.json has no writes journey named book (or booking, reserve, reservation, appointment), or, when the check runs on a throwaway test site that allows writes (pooled data sites), when that journey does not run and pass. That test booking lands only on the throwaway test site, never on the live site, so build_booking_smoke (the old-flow live-site booking probe) does not govern it; a read-only check on a dedicated, kernel or static site requires the journey to exist but cannot run its writes. The failure tells the owner to ask in the chat for the booking check or a booking fix and publish again. When the site is published by a separate Publish run, the build idea is not at hand and only zavi-site.json decides. A site that is already live is not checked. TRUE (default). FALSE = no such prompt rule, and a booking site with no booking journey passes, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  site_favicon_og_404_check: {
    description:
      "New-flow sites ship a tab icon, link-preview tags and a page-not-found page: on a site's first publish the site check opens the staged site and fails when the home page has no <link rel=icon> or that icon does not load, has no og:title or og:description, or a made-up address shows the home page, a blank or bare Not Found page, the router's default error screen, or answers an HTTP error. A static site answers 200 for any path, so the made-up address is judged by what it shows. The failure tells the owner what is missing and to ask for it in the chat, then publish again. A site that is already live is not checked, so an edit that takes the light check (site_light_gate_copy_edits) never runs it. TRUE (default). FALSE = only the title and description checks of site_meta_and_404 run, as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  live_edit_publish_clears_inline_edits: {
    description:
      "Build live edit: pressing Publish on a draft refine also clears the tenant's inline website edits (draft and published), the same way an auto-published refine already does, because the refine rebuilt the page and selector-keyed overrides can miss or hit the wrong element. Default ON; OFF = Publish keeps inline edits.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  website_chat_confirm_copy_by_path: {
    description:
      "Website chat app-edit confirm prompt names the path the refine will really take: a live-edit draft that waits for Publish, an automatic go-live, or a pull request. Default ON; OFF = the prompt always says it opens a pull request for review.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  website_edit_plain_instruction: {
    description:
      "Website inline edit and chat edit (POST /api/website/resolve-edit and /resolve-chat-edit): the owner's instruction reaches the model as plain sanitized text inside the JSON request instead of XML-escaped text, so an apostrophe, quote or ampersand in the instruction can no longer come back as &apos;, &quot; or &amp; in the stored edit, and a full-length instruction is no longer cut short by the escaping. Injection patterns are still redacted. Default ON; OFF = the instruction is XML-escaped as before.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  static_hosting_enabled: {
    description:
      "Static hosting: a fresh build whose app has no database, API routes, middleware or server actions is exported with next export and served from Cloudflare R2 behind the static-host Worker instead of waiting on Render. Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STATIC_API_TOKEN, CLOUDFLARE_ZONE_ID and the ZAVI_STATIC_* env; unconfigured or ineligible builds use Render exactly as today. TRUE (default). FALSE = Render only.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  refine_gate_evidence_enabled: {
    description:
      "Gate a braked refine's parked PR on build+test + preview-smoke evidence BEFORE the PR opens (Option A). ON (default) = [engineer(defer_pr), refine_gate] then conductor opens the PR with evidence + a review-ready/gate-failed label. OFF = brake-v1.1 (PR opens immediately, ungated).",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  deploy_truth_enabled: {
    description:
      "Watch a merged provisioned-app PR until the Render-served commit SHA matches the merged SHA AND the app health-probes 2xx before it reports 'live' (deploy_healthy / deploy_failed). Surfaces a rollback button (never auto-rollback). OFF = no deploy-watch.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  voice_enabled: {
    description:
      "Master gate for voice agent sessions. OFF = disables all voice runs fleet-wide. (Per-tenant voice settings still apply on top.)",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  onboarding_web_enrichment: {
    description:
      "At signup, fetch a new tenant's website to pre-fill their company brain. OFF = skip enrichment.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  onboarding_enrichment_enabled: {
    description:
      "Spend brake for onboarding enrichment. OFF = the expensive /api/onboarding/enrich `full` pass (site crawl + app-store + web research + LLM passes) skips immediately and costs nothing; the wizard degrades to its no-enrichment path. Default ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  growth_intake_research_enabled: {
    description:
      "Spend brake for the CGO intake's research pass (POST /api/workspace/growth-intake/research: third-party web research + competitor search + a sitemap-seeded site crawl, once per tenant per day). OFF = the pass skips immediately and costs nothing; the intake falls back to its site-only opening. Default ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  geo_prompt_runner_enabled: {
    description:
      "Spend brake for the GEO prompt runner (POST /api/geo/sweeps). OFF = no new sweep is admitted and nothing is spent; stored metrics keep rendering. Default ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  geo_prompt_repeats: {
    description:
      "Times each GEO prompt is asked of each engine per sweep. Model output is non-deterministic, so the doc makes at least 3 mandatory. Default 3.",
    type: "number",
    scope: "global",
    defaultValue: 3,
    min: 3,
    max: 5,
  },
  geo_prompt_tenant_cap_7d: {
    description:
      "Max GEO sampled responses PLANNED per tenant in any rolling 7 days, across all countries. A full sweep of 25 prompts x 4 engines x 3 repeats is 300. Enforced in SQL before a sweep starts; 0 blocks all sweeps. Default 600.",
    type: "number",
    scope: "global",
    defaultValue: 600,
    min: 0,
    max: 10000,
  },
  geo_prompt_max_sweeps_per_tenant: {
    description:
      "Hard lifetime cap on how many GEO sweeps a tenant may run (the 'a few runs per workspace for now' lever). Counts ONLY sweeps that finished with data (complete/partial); a sweep that failed with zero responses does not burn the allowance, so a broken first run can be retried. Enforced in SQL (geo_open_prompt_sweep) before a sweep starts; 0 blocks all sweeps, a high value is effectively unlimited. Default 12.",
    type: "number",
    scope: "global",
    defaultValue: 12,
    min: 0,
    max: 1000,
  },
  reddit_workspace_v2: {
    description:
      "Kill switch for the Reddit workspace panel (tracked keywords / competitors / communities, the insights tabs and every /api/reddit route). OFF = the routes 404 and the panel falls back to the plain suggestion list; stored rows are untouched. Default ON.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  reddit_sweep_enabled: {
    description:
      "Brake for the Reddit insights sweep (Apify scrape of tracked subreddits and terms, then scoring and Google rank). OFF = no sweep starts, manual or scheduled. Default ON.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  reddit_sweep_tenant_cap_usd_7d: {
    description:
      "Per-tenant ceiling, in USD, on Reddit sweep spend in any rolling 7 days (Apify + DataForSEO, estimated at admission). Enforced in SQL before a sweep starts; 0 blocks. Default 3.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 3,
    min: 0,
    max: 500,
  },
  reddit_sweep_fleet_cap_usd_24h: {
    description:
      "Fleet-wide ceiling, in USD, on Reddit sweep spend in any rolling 24 hours. Enforced in SQL before a sweep starts; 0 blocks all sweeps. Default 25.",
    type: "number",
    scope: "global",
    defaultValue: 25,
    min: 0,
    max: 5000,
  },
  reddit_sweep_max_jobs: {
    description:
      "Most Apify calls one Reddit sweep may make (selected subreddits first, then tracked terms). Default 12.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 12,
    min: 1,
    max: 60,
  },
  reddit_relevance_threshold: {
    description:
      "Relevance score (0-100) at or above which a Reddit post or comment counts as relevant in the panel. A product setting, not a Reddit fact. Default 60.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 60,
    min: 0,
    max: 100,
  },
  geo_prompt_fleet_cap_usd_24h: {
    description:
      "Fleet-wide ceiling, in USD, on GEO prompt-sweep spend in any rolling 24 hours (estimated at admission, real DataForSEO cost once a sweep finishes). Enforced in SQL before a sweep starts; 0 blocks all sweeps. Default 50.",
    type: "number",
    scope: "global",
    defaultValue: 50,
    min: 0,
    max: 5000,
  },
  geo_prompt_claude_model: {
    description:
      "Model DataForSEO asks for the Claude column of a GEO sweep (llm_responses, web search on). Must be a model DataForSEO lists as web-search capable (GET /v3/ai_optimization/claude/llm_responses/models). Default claude-sonnet-5, verified in that list 2026-09-17.",
    type: "string",
    scope: "global",
    defaultValue: "claude-sonnet-5",
  },
  geo_prompt_perplexity_model: {
    description:
      "Model DataForSEO asks for the Perplexity column of a GEO sweep (llm_responses; Sonar models search by default). Default sonar.",
    type: "string",
    scope: "global",
    defaultValue: "sonar",
  },
  geo_crawler_ingest_enabled: {
    description:
      "Kill switch for the GEO crawler-log ingest endpoint. OFF = pushed logs are refused with 503 and nothing is stored; tokens and stored counts are kept. Default ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  pm_roadmap_enabled: {
    description:
      "Enable the PM agent's multi-surface roadmap synthesis (an expensive pass). OFF = PM skips roadmap generation. Default: ON.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  connector_skill_compounding_enabled: {
    description:
      "Compounding connector skill memory. ON by default fleet-wide: successful agent runs distill stable connector facts (tools the fleet reliably uses + connected workspace/account identity) into tenant_connector_skill, and the dispatcher injects them into the prompt for CONNECTED connectors. Strictly tenant-scoped — each tenant only ever reads/writes its OWN connector facts. A tenant can opt out with a per-tenant false override.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  memory_skill_distill_enabled: {
    description:
      "Auto-distill shared 'skill' notes (Viktor-parity procedural memory) from a tenant's repeated successful agent runs. ON = the daily distill-skill-candidate worker writes cross-agent note_type:'skill' prose (trust_tier 2, operator-editable in BrainTab) for recurring tool-sequences. Default ON fleet-wide 2026-06-30 (Ravi); a tenant can still opt out with an explicit false override (per-tenant-only consent flag — a global write can never arm distillation for the whole fleet). Idempotent (source_ref dedup); derives only tool names + counts, no raw user content.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  sandbox_enabled_agents: {
    description:
      "Allowlist of agent slugs for which the e2b code sandbox is force-enabled (lazy-provisioned on first code-tool call), layered on top of each agent's requires_sandbox frontmatter. Default ['*'] = ON for every agent, all tenants (current + future). engineer stays eager via frontmatter; operator is excluded via the denylist; lazy provisioning + the per-tenant sandbox_lazy_daily_cap still apply; the sandbox money-key exclusion (GITHUB_TOKEN-only injection) is unaffected. A tenant can opt out with a per-tenant override of [] or a specific slug list.",
    type: "json",
    scope: "per-tenant",
    defaultValue: ["*"],
  },
  sandbox_lazy_daily_cap: {
    description:
      "Max LAZY (on-first-code-tool-call) e2b sandbox provisions per tenant per UTC day for flag-enabled (non-engineer) agents. Exhaustion denies the next provision with a clear tool-error (cost safeguard). 0 = uncapped. Does not affect engineer's eager path.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 50,
  },
  launch_video_public_enabled: {
    description:
      "Master kill switch for the PUBLIC /launch-video self-serve generator. When OFF the public generate endpoint refuses all requests (zero spend). Separate from the operator render-capability flag (system_config render_launch_video_*) which gates whether rendering WORKS. Default ON (Ravi 2026-07-03) — each visitor gets a per-visitor shell tenant; spend is bounded by the per-IP + global daily caps. Flip a global OFF override to pause the surface.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  launch_video_theme_film_enabled: {
    description:
      "When ON, the public launch-video render FILLS a film we own (packages/launch-video/src/themes/swiss-kinetic.tsx) with the customer's intake instead of asking a model to write the film. Measured reason: across five renders of one site the model-written lane produced 91, 79 and 83 percent frozen frames against a reference film's 3, with cut counts of 3, 16, 12, 3, 3 on identical input; three prompt-side interventions moved it by less than the run-to-run variance. It is also the safer path by construction: no model-written code executes in the render sandbox, so the static pattern gate that three adversarial rounds bypassed eleven times stops being load-bearing here. Takes precedence over launch_video_authored_enabled when both are on.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  launch_video_film_facts_enabled: {
    description:
      "When ON, a public launch-video render that Zavi picks the film for reads the visitor's own pages (homepage plus up to 6 same-origin pages, through the SSRF guard and sanitizer) and asks a model to fill the IN USE and journey films' richer content: the product's filters, listings, booking states, prices, lists. Every block is shape-checked and every number in it must appear on the site or in the intake, or the block is dropped. One extra model call per render, inside the existing per-IP and global render caps. OFF leaves both films on the thinner plan they derive from the plain intake.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  launch_video_authored_enabled: {
    description:
      "When ON, a model WRITES the film for each public launch-video render instead of assembling it from the shared scene components, which is what stops generated films holding a still image for three quarters of every scene. Adds one full-model call per render, so it is a real per-render cost increase on an anonymous endpoint (Ravi authorized that spend 2026-09-22 and asked for it ON by default). Failure is always best-effort: an authoring error, an unsafe film or a film that will not compile falls back to the assembled render, so a visitor never loses their video over this. KNOWN RISK, accepted by Ravi with the detail in hand: the film is model-written code executing in a render sandbox that still has network, and the static gate in services/launch-video/authored-film.ts is pattern-based, which three adversarial rounds bypassed eleven times before it was tightened. The durable fix is to drop egress in the sandbox after npm install so the gate stops being load-bearing.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  launch_video_public_moderation_enabled: {
    description: "Run the LLM content-safety gate on public /launch-video submits. OFF while the page is unlinked and untrafficked; turn ON before giving it reach — the render watermarks every video with zaviagent.com, so what it generates is a branded artifact.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  launch_video_public_captcha_required: {
    description: "Require a Cloudflare Turnstile token on public /launch-video submits. Turn ON only AFTER TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY are in praxis-envprod-1 and the container has restarted — enabled-without-secret refuses every submit by design.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  launch_video_public_prefill_per_ip_day: {
    description: "Max public /launch-video website lookups (URL to prefilled form) per client IP per rolling 24h. Each costs one page fetch plus one fast model call. 0 = uncapped.",
    type: "number",
    scope: "global",
    defaultValue: 40,
    min: 0,
    max: 500,
  },
  launch_video_public_prefill_global_day: {
    description:
      "Max public /launch-video website lookups across ALL callers per rolling 24h, the ceiling on what this endpoint can spend in a day. The per-IP meter bounds one address; it does nothing against a caller rotating addresses, and this endpoint is anonymous and costs a page fetch plus a model call every time. Sized well above any plausible real day so it is a runaway stop, not a product limit. 0 = uncapped.",
    type: "number",
    scope: "global",
    defaultValue: 2_000,
    min: 0,
    max: 100_000,
  },
  launch_video_public_attempts_per_ip_day: {
    description: "Max public launch-video generate ATTEMPTS (including rejected ones) per client IP per rolling 24h. Bounds the model spend a rejected submit costs us, which the render caps cannot see. 0 = uncapped.",
    type: "number",
    scope: "global",
    defaultValue: 20,
    min: 0,
    max: 500,
  },
  launch_video_public_attempts_global_day: {
    description: "Max TOTAL public launch-video generate ATTEMPTS (including rejected ones) across all visitors per rolling 24h. Bounds Anthropic spend against a distributed loop that stays under the per-IP cap. 0 = uncapped.",
    type: "number",
    scope: "global",
    defaultValue: 1000,
    min: 0,
    max: 20000,
  },
  launch_video_public_cap_per_ip_day: {
    description: "Max public launch-video renders per client IP per UTC day. One of several bounds now: see also the attempt meter and launch_video_public_captcha_required. 0 = uncapped.",
    type: "number",
    scope: "global",
    defaultValue: 5,
    min: 0,
    max: 100,
  },
  launch_video_public_cap_global_day: {
    description: "Max TOTAL public launch-video renders across all visitors per UTC day (hard cost ceiling — the main runaway-spend guard). 0 = uncapped.",
    type: "number",
    scope: "global",
    defaultValue: 200,
    min: 0,
    max: 5000,
  },
  affiliate_payouts_enabled: {
    description: "Daily affiliate payout job: transfer matured commissions (>= $20) to creators' Stripe Express accounts. Accrual is always on.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  start_card_enabled: {
    description: "Public /start growth card (POST/GET /api/public/start-card). OFF 404s the create route and stops the email-queue drain; existing result links keep working.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  growth_leaderboard_enabled: {
    description: "Public Growth Leaderboard (GET /api/public/leaderboard + /rank/:public_id, the /growth page and the rank line on finished cards). OFF 404s both routes, so /growth 404s and finished cards show no rank line.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  growth_leaderboard_excluded_domains: {
    description: "Domains kept off the public Growth Leaderboard (/growth). A JSON array of hosts, e.g. [\"acme.com\"]; \"www.\" and letter case are ignored. The card itself and its share link are untouched. Saving a value replaces this default list, so keep the entries you still want. Takes effect within about a minute.",
    type: "json",
    scope: "global",
    defaultValue: [
      "supabase.com",
      "github.com",
      "gamestop.com",
      "instagram.com",
      "nordstrom.com",
      "wordpress.org",
      "azelis.com",
      "wikipedia.org",
      "vercel.com",
      "youtube.com",
      "facebook.com",
      "linear.app",
      "google.com",
      "spotify.com",
      "amazon.in",
      "amazon.com",
      "x.com",
      "hotstar.com",
      "starbucks.co.uk",
      "starbucks.com",
      "flipkart.com",
      "gmail.com",
      "zomato.com",
      "acme.com",
      "iana.org",
      "demowebshop.tricentis.com",
    ],
  },
  start_card_captcha_required: {
    description: "Require a Cloudflare Turnstile token on public /start card submits and email-queue requests. Needs TURNSTILE_SECRET_KEY + TURNSTILE_SITE_KEY in the environment; enabled-without-secret refuses every submit by design. Local dev: use Cloudflare's always-pass test keys rather than turning this off (the local stack shares prod settings).",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  staff_model_test_daily_usd: {
    description: "Daily total spend (USD, UTC day) for staff runs started with ?model= (incl. handoffs). At or over the cap, new ?model= runs are refused.",
    type: "number",
    scope: "global",
    defaultValue: 200,
    min: 0,
    max: 10000,
  },
  start_card_daily_usd: {
    description: "Daily dollar ceiling for public /start cards (UTC day). 0 = the date-based default in code: $900/day 13-19 Oct 2026 (launch week), $50/day otherwise. When the day's budget is spent, new visitors are offered 'email me my card' instead.",
    type: "number",
    scope: "global",
    defaultValue: 0,
    min: 0,
    max: 10000,
  },
  credits_soft_warn_enabled: {
    description:
      "Move 14 — show an advisory 'you're running low on credits' banner (and return soft_warn from /api/billing/credits) once a credit-enforced tenant's SPENDABLE balance (effective_available, counting purchased top-ups) drops to ≤20% of the monthly allowance. One tier above the ≤10%-remaining low-credits banner; keys off spendability not included-usage, so a topped-up wallet isn't nagged. Warning-only, no effect on the 402/enforcement path. Default ON (copy approved 2026-07-14); set a per-tenant override to disable.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  honest_liveness_label_enabled: {
    description:
      "Move 5 — honest state (not a green 'done') when a run's liveness_tier is plan_only (proposed-but-held) or empty (narrated success, nothing observable): a neutral Slack reaction instead of ✅, plus web-chat telemetry. No text banner on any surface. shipped/answered runs unchanged; engineer excluded. Default OFF; flip global or per-tenant to enable.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  raise_room_advisor: {
    description:
      "Kill-switch for the Raise Room fundraise-advisor layer. ON (default) = the fundraising dashboard builder adds an additive `raise` key (raise-phase cursor + deterministic next-action / funnel / momentum-gate / forecast / alert signals from the fundraising_raise state). OFF = the builder omits the key and the dashboard is byte-for-byte unchanged. Advises-only (never sends); reads only the tenant's own fundraising state. Flip OFF (per-tenant or the global row) to disable with no redeploy.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  website_app_details: {
    description:
      "Operator-authored title and description for the built app's Overview card. {name, description}, with null values falling back to the original build-derived copy. Set via POST /api/website/settings.",
    type: "json",
    scope: "per-tenant",
    defaultValue: { name: null, description: null },
  },
  website_app_visibility: {
    description:
      "Access posture shown on the built app's Overview console (Your Website tab): public | private | unlisted. Per-tenant operator intent for the tenant's OWN deployed app; set via the authed POST /api/website/settings route. Default 'public'. Deployed-app enforcement is a later slice — today this is the stored source of truth the console reflects.",
    type: "string",
    scope: "per-tenant",
    options: ["public", "private", "unlisted"],
    defaultValue: "public",
  },
  site_builder_detected: {
    description:
      "Detected site builder for the tenant's website ({builder, checked_at}); drives the 'How to do this' steps on copy-to-your-site channel cards. Written by services/channels/site-builder.ts, re-checked every 30 days (1 day after a failed check).",
    type: "json",
    scope: "per-tenant",
    defaultValue: { builder: null, checked_at: null },
  },
  website_platform_badge_hidden: {
    description:
      "Whether the 'Made with Zavi' platform badge is hidden on the tenant's built app, as toggled from the Overview console (Your Website tab). Per-tenant; set via POST /api/website/settings. Default false (badge shown). The badge is injected/removed on the deployed app at runtime by zavi-editor-runtime.js, gated by platform_badge_global_enabled.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: false,
  },
  platform_badge_global_enabled: {
    description:
      "GLOBAL master switch for injecting the 'Made with Zavi' badge onto deployed tenant apps. Default OFF — no app shows the badge until this is enabled fleet-wide. When ON, the per-tenant website_platform_badge_hidden flag decides per app. Fail-closed: OFF (and read-error) => badge hidden.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  anthropic_oauth_token_pool: {
    description:
      "Claude subscription OAuth tokens (comma-separated oat-… list) driving the agent fleet. Overrides the CLAUDE_CODE_OAUTH_TOKENS/CLAUDE_CODE_OAUTH_TOKEN env vars within ~60s, no restart. Empty = use env. Redacted on staff list surfaces.",
    type: "string",
    scope: "global",
    defaultValue: "",
    secret: true,
    secretList: true,
  },
  mobile_signup_enabled: {
    description:
      "Show the signup affordances in the Zavi mobile app. Read pre-auth by GET /api/mobile/config as `isSignupEnabled`. Default ON; flip a global OFF override to remotely remove mobile signup without shipping an app build (propagates within ~60s, the settings cache TTL). CLIENT-SIDE gate only — it hides UI, it does NOT block Supabase auth, so it is not a security control.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  mobile_ios_billing_enabled: {
    description:
      "Show Settings -> Billing & credits in the Zavi mobile app on iOS and Android (Android also hides it while this is OFF, for Google Play review). Read by GET /api/mobile/config as `isIosBillingEnabled`. Default ON; flip a global OFF override to hide it on both platforms without an app build (~60s, the settings cache TTL). CLIENT-SIDE gate only, not a security control.",
    type: "boolean",
    scope: "global",
    defaultValue: true,
  },
  ios_app_store_live: {
    description:
      "The Zavi iOS app is live on the App Store. OFF: the website's App Store badge shows locked as 'Coming soon'. ON: it links to the App Store listing. Read by GET /api/mobile/config as `isIosAppStoreLive`; takes effect within ~60s, no deploy.",
    type: "boolean",
    scope: "global",
    defaultValue: false,
  },
  team_note_enabled: {
    description:
      "After a chat reply goes badly, draft a note and offer the founder a one-click 'Send to Zavi team' strip. Nothing is sent without their click.",
    type: "boolean",
    scope: "per-tenant",
    defaultValue: true,
  },
  team_note_max_per_thread: {
    description:
      "Max hard-failure 'Send to Zavi team' strips SHOWN in one chat thread per window (team_note_thread_window_hours).",
    type: "number",
    scope: "per-tenant",
    defaultValue: 1,
    min: 0,
    max: 20,
  },
  team_note_thread_window_hours: {
    description:
      "Rolling window, in hours, for team_note_max_per_thread.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 24,
    min: 1,
    max: 720,
  },
  team_note_max_per_day: {
    description:
      "Max hard-failure 'Send to Zavi team' strips SHOWN to one founder in one company in a rolling 24 hours. Pushback strips and reply flags spend no cap.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 1,
    min: 0,
    max: 50,
  },
  team_note_stop_offer_after_dismissals: {
    description:
      "After this many dismissed hard-failure strips in a row, the next strip also offers 'Stop suggesting these'. 0 = never.",
    type: "number",
    scope: "per-tenant",
    defaultValue: 1,
    min: 0,
    max: 10,
  },
  team_note_rephrase_similarity: {
    description:
      "Word overlap (Jaccard, 0-1) above which a founder's next message counts as a rephrase of their previous one.",
    type: "number",
    scope: "global",
    defaultValue: 0.6,
    min: 0.3,
    max: 1,
  },
  team_note_tool_loop_threshold: {
    description:
      "A chat run that calls the same tool with the same input this many times (any outcome) is flagged as looping and its reply goes to the team-note judge.",
    type: "number",
    scope: "global",
    defaultValue: 3,
    min: 2,
    max: 50,
  },
  team_note_tool_thrash_threshold: {
    description:
      "A chat run that calls the same tool this many times (any input, any outcome) is flagged as thrashing and its reply goes to the team-note judge.",
    type: "number",
    scope: "global",
    defaultValue: 10,
    min: 3,
    max: 200,
  },
  team_note_retention_days: {
    description:
      "Days a sent team report is kept before it is deleted (max 180; team_note_send also clamps to 180). The privacy page states 180; change both together.",
    type: "number",
    scope: "global",
    defaultValue: 180,
    min: 7,
    max: 180,
  },
  team_note_offer_retention_days: {
    description:
      "Days the text-free offers ledger (drafted/shown/sent/dismissed timestamps) and judge claims are kept.",
    type: "number",
    scope: "global",
    defaultValue: 400,
    min: 30,
    max: 1095,
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof APP_SETTINGS;

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(APP_SETTINGS, k);
}

export const CONSENT_KEYS_PER_TENANT_ONLY: ReadonlySet<string> = new Set<string>([
  "cross_customer_learning_consent",
  "cgo_autopilot_enabled",
  "build_replay_fixture",
  "slack_approval_push_enabled",
  "slack_connector_alert_enabled",
  "autopilot_digest_push_enabled",
  "autopilot_digest_email_enabled",
  "material_news_enabled",
  "mention_alerts_enabled",
  "autopilot_trust_level",
  "qa_weekly_execute_enabled",
  "qa_weekly_allow_writes",
  "local_lane_side_effects_allowlist",
  "engineer_runs_local",
  "competitor_intel_custom_brands",
  "competitor_intel_rec_decisions",
  "memory_agentic_read_enabled",
  "memory_conflict_resolution_enabled",
  "memory_llm_entity_extract_enabled",
  "memory_valid_time_enabled",
  "memory_heartbeat_enabled",
  "bulk_outbound_enabled",
  "outbound_basis",
  "memory_skill_distill_enabled",
  "marketplace_intel_enabled",
  "marketplace_intel_dashboard_enabled",
]);
