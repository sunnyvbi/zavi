
import { EventSchemas, Inngest } from "inngest";
import { resolveInngestAppId } from "@/services/config/env-targets";
import { withBackgroundBrake } from "./background-brake";

type AgentRunRequested = {
  data: {
    run_id: string;
    tenant_id?: string;
    agent_slug?: string;
    lane?: "interactive" | "background";
  };
};

type AgentRunCompleted = {
  data: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    status: "success" | "parse_failed" | "dispatch_error" | "failed";
  };
};

type AgentRunFailed = {
  data: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    error: string;
  };
};

type CronScheduledRunsTick = {
  data: Record<string, never>;
};

type CronCleanupOauthStates = {
  data: Record<string, never>;
};

type CronQueuedStuckScan = {
  data: Record<string, never>;
};

type EvalScoreRunsRequested = {
  data: Record<string, never>;
};

type ConductorTickRequested = {
  data: { conductor_run_id: string };
};

type BuildScreenCheckRequested = {
  data: { conductor_run_id: string; node_id: string };
};

type SiteActivate = {
  data: { tenant_id: string; site_id: string; deploy_id: string; sha: string };
};

type SiteThumbnailRequested = {
  data: { tenant_id: string; run_id?: string; site_id?: string; heal?: true };
};

type SiteReconcile = {
  data: { tenant_id: string; site_id: string };
};

type SiteFunctionRunsInvoke = {
  data: { runs: Array<{ id: string; attempt: number }> };
};

type SiteShardProvisionRequested = {
  data: {
    env: "prod" | "dev";
    ledger_id: string;
    shard_name: string;
    n: number;
    region: string;
    canary: boolean;
    source: "auto" | "staff";
  };
};

type BuildStaticPublishRequested = {
  data:
    | { tenant_id: string; conductor_run_id: string; sha: string; hostname: string }
    | { tenant_id: string; sha: string; hostname: string; reason: "live_edit_publish" | "revert" };
};

type EvalGroundRequested = {
  data: Record<string, never>;
};

type DecisionApproved = {
  data: {
    decision_id: string;
    tenant_id: string;
    decision_class: string;
  };
};

type ChannelActionApproved = {
  data: {
    action_id: string;
  };
};

type DecisionRejected = {
  data: {
    decision_id: string;
    tenant_id: string;
    decision_class: string;
  };
};

type AgentPlanCriticNeeded = {
  data: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    plan: {
      summary: string;
      steps: string[];
      files: string[];
    };
  };
};

export type SlackBatchDecide = {
  data: {
    tenant_id: string;
    run_id: string;
    actor_user_id: string;
    action: "approve" | "reject";
    cutoff_ms: number;
    response_url: string | null;
  };
};

export type SlackApprovalNlRoute = {
  data: {
    tenant_id: string;
    run_ids: string[];
    thread_ts: string;
    channel_id: string;
    team_id: string | null;
    text: string;
  };
};

export type AgentWorkItemEnqueued = {
  data: {
    work_item_id: string;
    tenant_id?: string;
    source?: string;
  };
};

type KnowledgeImportRead = {
  data: {
    doc_id: string;
    tenant_id?: string;
  };
};

export type GrowthGoalAttention = {
  data: {
    tenant_id: string;
    reason: "goal_set" | "card_rejected";
    goal_id?: string;
    run_id?: string;
    decision_id?: string;
  };
};

export type CgoNoteEmail = {
  data: { run_id?: string; note_id?: string; tenant_id: string };
};

export type CgoAnswersAnswered = {
  data: { tenant_id: string; via: "email" | "slack" | "web"; question_ids: string[] };
};

export type StartCardRequested = {
  data: { card_id: string };
};

export type StartCardQueueDrain = {
  data: Record<string, never>;
};

export type AdBudgetBrakeDue = {
  data: {
    tenant_id: string;
    budget_id: string;
    projected_usd: number;
    cap_usd: number;
    day: string;
  };
};

type AffiliateStripeEventRetry = { data: { event_id: string } };

export type Events = {
  "onboarding/scan.requested": { data: { scan_id: string } };
  "onboarding/scan.finished": { data: { scan_id: string } };
  "tenant/onboarding.memory.requested": { data: { tenant_id: string; attempt: number } };
  "ad-budget/brake.due": AdBudgetBrakeDue;
  "affiliate/stripe-event.retry": AffiliateStripeEventRetry;
  "start-card/requested": StartCardRequested;
  "start-card/queue.drain": StartCardQueueDrain;
  "start-card/tenant.settle": { data: { card_id: string } };
  "site-shards/schema-rollout.requested": { data: { reason: string } };
  "knowledge/import.read": KnowledgeImportRead;
  "growth/goal.attention": GrowthGoalAttention;
  "founder_order/advise.requested": { data: { decision_id: string } };
  "chat_card/deliver.requested": { data: { card_id: string; run_id: string; table: "decisions" | "channel_actions" } };
  "cgo/note.email": CgoNoteEmail;
  "cgo/answers.answered": CgoAnswersAnswered;
  "agent.run.requested": AgentRunRequested;
  "agent.work_item.enqueued": AgentWorkItemEnqueued;
  "agent.run.completed": AgentRunCompleted;
  "agent.run.failed": AgentRunFailed;
  "cron.scheduled-runs.tick": CronScheduledRunsTick;
  "cron.oauth-states.cleanup": CronCleanupOauthStates;
  "cron.queued-stuck.scan": CronQueuedStuckScan;
  "decision.approved": DecisionApproved;
  "bulk-email/fanout.requested": { data: { send_id: string } };
  "bulk-email/fanout.stopped": { data: { send_id: string } };
  "email-send-outcome/tell.requested": { data: import("@/services/email-cards/outcome-tell").EmailSendOutcomeTellEvent["data"] };
  "channel-action.approved": ChannelActionApproved;
  "channel-action.exec-reconcile": ChannelActionApproved;
  "decision.email-send-reconcile": { data: { decision_id: string } };
  "ops/alert.enqueued": { data: Record<string, never> };
  "decision.rejected": DecisionRejected;
  "webhook.slack.ingested": WebhookSlackIngested;
  "slack.batch.decide": SlackBatchDecide;
  "slack.approval.nl_route": SlackApprovalNlRoute;
  "meeting.bot.status": MeetingBotStatus;
  "meeting.notice": MeetingNotice;
  "webhook.email.ingested": WebhookEmailIngested;
  "chat.turn_complete": ChatTurnComplete;
  "agent.run.distillable": AgentRunDistillable;
  "agent.run.terminal": AgentRunTerminal;
  "tenant.auto_provision.requested": TenantAutoProvisionRequested;
  "geo.prompt_sweep.requested": GeoPromptSweepRequested;
  "reddit.sweep.requested": RedditSweepRequested;
  "growth.preview_upgrade.requested": GrowthPreviewUpgradeRequested;
  "tenant.bootstrap_anchors.requested": TenantBootstrapAnchorsRequested;
  "team.discover.requested": TeamDiscoverRequested;
  "marketplace.rollup.requested": MarketplaceRollupRequested;
  "patterns.tenant.requested": PatternsTenantRequested;
  "agent.plan-critic-needed": AgentPlanCriticNeeded;
  "handoff.batch.join.requested": HandoffBatchJoinRequested;
  "agent.child.completed": AgentChildCompleted;
  "agent.ask.deadline": AgentAskDeadline;
  "custom-agent/handoff.join.requested": CustomAgentHandoffJoinRequested;
  "slack.oauth.completed": SlackOauthCompleted;
  "slack.workspace.intro": SlackWorkspaceIntro;
  "slack.channel.summarize.tenant.requested": SlackChannelSummarizeTenantRequested;
  "slack.channel.summarize.requested": SlackChannelSummarizeRequested;
  "memory.note.enrich.requested": MemoryNoteEnrichRequested;
  "memory.dream_cycle.tenant": MemoryTenantJob;
  "memory.note.forget.requested": MemoryNoteForgetRequested;
  "memory.cleanup.duplicates.requested": MemoryCleanupRequested;
  "memory.cleanup.duplicates.tenant": MemoryTenantJob;
  "ads-wallet/tick.batch": { data: { tenant_ids: string[] } };
  "slack.w2.purge.requested": SlackW2PurgeRequested;
  "slack.channel.members.refresh.tenant.requested": SlackChannelMembersRefreshTenantRequested;
  "engineer.postdeploy.verify.requested": EngineerPostdeployVerifyRequested;
  "engineer.pr.ci.readback.requested": EngineerPrCiReadbackRequested;
  "repo.profile.build.requested": RepoProfileBuildRequested;
  "operator-db.discover.requested": OperatorDbDiscoverRequested;
  "db-retention.continue": { data: { purge: "raw_results" | "chat_answers" | "access_log" } };
  "db-cleanup.run": { data: Record<string, never> };
  "booking-mapping.detect.requested": BookingMappingDetectRequested;
  "outcome-rollup.refresh.requested": BookingMappingDetectRequested;
  "slack.outbox.enqueued": SlackOutboxEnqueued;
  "meta_ads.token_invalid": MetaAdsTokenInvalid;
  "ad_budget.reconnect_read.requested": AdBudgetReconnectReadRequested;
  "meta_ads.deauthorized": MetaAdsDeauthorized;
  "repo.conventions.distill.requested": RepoConventionsDistillRequested;
  "qa/weekly.execute.requested": QaWeeklyExecuteRequested;
  "agents/nightly.self-improve.requested": NightlySelfImproveRequested;
  "agents/shadow-canary.cron.requested": ShadowCanaryCronRequested;
  "eval/score-runs.requested": EvalScoreRunsRequested;
  "conductor/tick.requested": ConductorTickRequested;
  "build/screen-check.requested": BuildScreenCheckRequested;
  "build/static-publish.requested": BuildStaticPublishRequested;
  "site/activate": SiteActivate;
  "site/reconcile": SiteReconcile;
  "site/thumbnail.requested": SiteThumbnailRequested;
  "site/preview-snapshot.requested": { data: { tenant_id: string; site_id: string } };
  "site-shards/provision.requested": SiteShardProvisionRequested;
  "site-shards/metrics.requested": { data: { env: string; reason: string } };
  "site-functions/runs.invoke": SiteFunctionRunsInvoke;
  "eval/ground.requested": EvalGroundRequested;
  "autopilot/connect.payouts_enabled": AutopilotConnectPayoutsEnabled;
  "fundraising/angel-round.requested": FundraisingAngelRoundRequested;
  "social/publish.requested": SocialPublishRequested;
  "video.render.requested": VideoRenderRequested;
  "video.generate.requested": VideoGenerateRequested;
  "video.generate.channel-action.requested": ChannelVideoGenerateRequested;
  "site.pr.started": SitePrStarted;
  "reminder/scheduled": ReminderScheduled;
  "creator/order.deadline.armed": CreatorOrderDeadlineArmed;
  "creator/order.payout.armed": CreatorOrderPayoutArmed;
  "creator/brief.answer_by.armed": CreatorBriefAnswerByArmed;
  "creator/rights_expiry.scheduled": CreatorRightsExpiryScheduled;
  "creator/setup.country_check": CreatorCountryCheck;
  "tenant/signup.followup": TenantSignupFollowup;
  "growth/plan-ready.email": GrowthPlanReadyEmail;
  "creator/illustration.generate": CreatorIllustrationGenerate;
  "creator/submission.preview.requested": CreatorSubmissionPreviewRequested;
  "creator/booking.link.requested": CreatorBookingLinkRequested;
  "team_note.candidate": TeamNoteCandidate;
  "team_report_ping.due": { data: { ping_id: number } };
  ping: PingEvent;
  pong: PongEvent;
};

type ReminderScheduled = {
  data: {
    reminder_id: string;
    due_at: string;
  };
};

type CreatorOrderDeadlineArmed = {
  data: {
    order_id: string;
    tenant_id: string;
    deadline_at: string;
    kind: "accept" | "review" | "due" | "no_show_grace" | "cancel_response" | "offer_expiry" | "checkout_expiry";
  };
};

type CreatorCountryCheck = {
  data: { human_member_id: string };
};

type TenantSignupFollowup = {
  data: { tenant_id: string; user_id: string };
};

type GrowthPlanReadyEmail = {
  data: { run_id: string; tenant_id: string };
};

type CreatorIllustrationGenerate = {
  data: { human_member_id: string };
};

type CreatorSubmissionPreviewRequested = {
  data: { order_id: string; version: number; tenant_id: string };
};

type CreatorBookingLinkRequested = {
  data: { order_id: string; tenant_id: string };
};

type CreatorOrderPayoutArmed = {
  data: {
    order_id: string;
    tenant_id: string;
    payout_ready_at: string;
  };
};

type CreatorBriefAnswerByArmed = {
  data: {
    brief_id: string;
    tenant_id: string;
    answer_by: string;
  };
};

type CreatorRightsExpiryScheduled = {
  data: {
    asset_id: string;
    rights_end_at: string;
  };
};

type VideoRenderRequested = {
  data: {
    run_id: string;
    tenant_id?: string;
    intake: Record<string, unknown>;
    delivery?: "slack" | "web";
    job_id?: string;
    tenant_lane_key: string;
    public_lane_key: string;
    delivery_target?:
      | { kind: "slack"; channel_id: string; thread_ts?: string; team_id?: string | null }
      | { kind: "chat"; thread_id: string };
    channel_id?: string;
    thread_ts?: string;
    team_id?: string | null;
  };
};

type VideoGenerateRequested = {
  data: {
    run_id: string;
    tenant_id?: string;
    intake: Record<string, unknown>;
    delivery_target?:
      | { kind: "slack"; channel_id: string; thread_ts?: string; team_id?: string | null }
      | { kind: "chat"; thread_id: string };
    channel_id?: string;
    thread_ts?: string;
    team_id?: string | null;
  };
};

type SitePrStarted = {
  data: {
    run_key: string;
    tenant_id: string;
  };
};

type ChannelVideoGenerateRequested = {
  data: {
    run_id: string;
    tenant_id?: string;
    intake: Record<string, unknown>;
    render_key: string;
    delivery_target: { kind: "channel_action"; action_id: string; claim_id: string };
  };
};

type SocialPublishRequested = {
  data: {
    post_id: string;
    tenant_id?: string;
    agent_run_id?: string | null;
  };
};

type RepoProfileBuildRequested = {
  data: {
    tenant_id: string;
    only_repos?: string[];
    force?: boolean;
  };
};

type OperatorDbDiscoverRequested = {
  data: {
    tenant_id: string;
    generation?: number;
  };
};

type BookingMappingDetectRequested = {
  data: {
    tenant_id: string;
  };
};

type SlackOutboxEnqueued = {
  data: {
    tenant_id: string;
  };
};

type MetaAdsTokenInvalid = {
  data: {
    tenant_id: string;
  };
};

type MetaAdsDeauthorized = {
  data: Record<string, never>;
};

type AdBudgetReconnectReadRequested = {
  data: {
    tenant_id: string;
  };
};

type RepoConventionsDistillRequested = {
  data: {
    tenant_id: string;
    repo_full_name: string;
    pull_number: number;
    pr_url: string;
  };
};

type EngineerPostdeployVerifyRequested = {
  data: {
    tenant_id: string;
    agent_run_id: string;
    repo: string;
    commit_sha?: string;
    remediation_attempt?: number;
  };
};

type EngineerPrCiReadbackRequested = {
  data: {
    tenant_id: string;
    decision_id: string;
    pr_url?: string;
    agent_run_id?: string | null;
  };
};

type CustomAgentHandoffJoinRequested = {
  data: { tenant_id: string; parent_run_id: string };
};

type AgentChildCompleted = {
  data: {
    child_run_id: string;
  };
};

type AgentAskDeadline = {
  data: {
    ask_id: string;
  };
};

type HandoffBatchJoinRequested = {
  data: {
    batch_id: string;
    tenant_id?: string;
  };
};

type PatternsTenantRequested = {
  data: {
    tenant_id: string;
    dispatched_at: string;
  };
};

type PingEvent = {
  data: { correlation_id: string };
};
type PongEvent = {
  data: { correlation_id: string; ts: string };
};

type MeetingBotStatus = {
  data: {
    meeting_bot_id: string;
    tenant_id: string;
    event: string;
  };
};

type MeetingNotice = {
  data: {
    meeting_bot_id: string;
    tenant_id: string;
    kind?: "waiting" | "no_record";
  };
};

type WebhookSlackIngested = {
  data: {
    ingested_event_id: string;
    tenant_id: string;
    event_type: string;
    slack_trace_id?: string;
  };
};

type WebhookEmailIngested = {
  data: {
    email_message_id: string;
    tenant_id: string;
    email_trace_id?: string;
  };
};

type MemoryNoteEnrichRequested = {
  data: {
    note_id: string;
    tenant_id?: string;
  };
};

type MemoryTenantJob = {
  data: {
    tenant_id: string;
  };
};

type MemoryNoteForgetRequested = {
  data: {
    request_id: string;
    tenant_id?: string;
  };
};

type MemoryCleanupRequested = {
  data: {
    tenant_id?: string;
  };
};

type SlackW2PurgeRequested = {
  data: {
    tenant_id: string;
    reason?: string;
  };
};

type SlackChannelMembersRefreshTenantRequested = {
  data: {
    tenant_id: string;
    dispatched_at: string;
  };
};

type ChatTurnComplete = {
  data: {
    run_id: string;
    tenant_id?: string;
    agent_slug?: string;
  };
};

type AgentRunDistillable = {
  data: {
    run_id: string;
    tenant_id?: string;
    agent_slug?: string;
  };
};

type AgentRunTerminal = {
  data: {
    run_id: string;
  };
};

type TenantAutoProvisionRequested = {
  data: {
    user_id: string;
  };
};

type GeoPromptSweepRequested = {
  data: {
    sweep_id: string;
    tenant_id?: string;
  };
};

type GrowthPreviewUpgradeRequested = {
  data: {
    run_id: string;
    tenant_id: string;
  };
};

type RedditSweepRequested = {
  data: {
    sweep_id: string;
    tenant_id?: string;
  };
};

type TenantBootstrapAnchorsRequested = {
  data: {
    tenant_id: string;
    seed_text: string;
  };
};

type TeamDiscoverRequested = {
  data: {
    job_id: string;
  };
};

type MarketplaceRollupRequested = {
  data: {
    tenant_id: string;
  };
};

type SlackOauthCompleted = {
  data: {
    tenant_id: string;
    team_id?: string;
    scopes_version: number;
  };
};

type SlackWorkspaceIntro = {
  data: {
    tenant_id: string;
    team_id: string;
    installer_slack_user_id: string | null;
  };
};

type SlackChannelSummarizeTenantRequested = {
  data: {
    tenant_id: string;
    dispatched_at?: string;
  };
};

type SlackChannelSummarizeRequested = {
  data: {
    tenant_id: string;
    channel_id?: string;
  };
};

type QaWeeklyExecuteRequested = {
  data: {
    tenant_id?: string;
    source?: string;
    dedupe_key?: string;
  };
};

type NightlySelfImproveRequested = {
  data: Record<string, never>;
};

type ShadowCanaryCronRequested = {
  data: Record<string, never>;
};

type FundraisingAngelRoundRequested = {
  data: {
    tenant_id: string;
    requested_by: string;
    run_id?: string | null;
  };
};

type AutopilotConnectPayoutsEnabled = {
  data: {
    stripe_account_id: string;
    tenant_id?: string;
  };
};

type TeamNoteCandidate = {
  data: {
    run_id: string;
    source: "run_end" | "correction" | "rephrase" | "edit";
    signals: string[];
    fingerprint: string;
    correction_message_id?: string;
    edited_message_id?: string;
  };
};

export const inngest = withBackgroundBrake(
  new Inngest({
    id: resolveInngestAppId(),
    schemas: new EventSchemas().fromRecord<Events>(),
  }),
);
