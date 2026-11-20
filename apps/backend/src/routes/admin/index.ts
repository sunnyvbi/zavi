import { staffTenantsGrowth, staffClassifyGrowthAccounts } from './tenants-growth';

import { Router } from "express";
import { forwardAsyncErrors } from "@/services/http/async-errors";
import { staffMiddleware, assertStaff } from "@/services/auth/staff-middleware";
import { staffHumanQueue, staffHumanDetail, staffHumanSetVetting } from "./humans";
import {
  staffCreatorDisputeQueue,
  staffCreatorDisputeDetail,
  staffCreatorDisputeResolve,
  staffCreatorDetail,
  staffCreatorRemove,
} from "./creator-network";
import { staffTenants, staffTenantsUsage, staffTenantSummary, staffTenantAgents, staffSetTenantKind } from "./tenants";
import { staffLoginAs } from "./login-as";
import { staffUserLookup } from "./user-lookup";
import { staffSetTenantPlan } from "./tenant-plan";
import { staffSetTenantDisabled } from "./tenant-disable";
import { staffTenantRuns } from "./runs";
import { staffTenantNeedsHelp } from "./needs-help";
import { staffTenantDecisions } from "./decisions";
import { staffTenantFeedback, staffFeedbackFirehose } from "./feedback";
import { staffProductFeedbackList, staffProductFeedbackUpdate } from "./product-feedback";
import { staffTenantAgentNote } from "./note";
import { staffTenantAgentBake } from "./agent-bake";
import { staffTenantAgentHealth } from "./agent-health";
import { staffTenantCoverageMap } from "./coverage-map";
import { staffCoachSetGoal } from "./coach-actions";
import {
  staffTenantReadiness,
  staffReadinessBoard,
  staffTenantFdeEvents,
  staffFdeAction,
} from "./readiness";
import { staffFdeDispatch } from "./fde-dispatch";
import { staffFdeFolds, staffFdeFoldDecide } from "./fde-folds";
import { staffBrainDrafts, staffBrainPromote } from "./brain-drafts";
import { staffRunsFirehose, staffRunDetail } from "./cross-tenant-runs";
import { staffRunRetry } from "./run-retry";
import { staffFirstPlanBackfill } from "./first-plan-backfill";
import { staffRunRecallTrace } from "./recall-trace";
import { staffMemoryWriteMetrics } from "./memory-write-metrics";
import { staffRunTrace } from "./run-trace";
import { staffFeedbackWrite } from "./staff-feedback-write";
import { staffTenantActivity } from "./tenant-activity";
import { staffTenantCredits, staffTenantCreditLedger } from "./tenant-credits";
import { staffTenantProfile } from "./tenant-profile";
import { staffCompanyFactsGet, staffCompanyFactsSet } from "./company-facts";
import { staffCompanyFactsSuggest } from "./company-facts-suggest";
import {
  staffRunReviewWrite,
  staffRunReviewList,
  staffJudgeCalibration,
} from "./run-review";
import { staffDecisionsFirehose, staffDecisionDetail } from "./cross-tenant-decisions";
import { staffDecisionDecide } from "./decision-decide";
import { staffAgentChat } from "./agent-chat";
import { staffAgentThreadRead } from "./agent-thread";
import { staffTenantThreadList, staffTenantThreadRead } from "./tenant-threads";
import { staffTeamNotesSummary, staffTeamReportList, staffTeamReportRead } from "./team-notes";
import { staffDecisionExecute } from "./decision-execute";
import { staffMemoryList } from "./memory";
import { staffAgentsFirehose } from "./agents";
import { staffStats } from "./stats";
import { staffOverview } from "./overview";
import { staffCosts } from "./costs";
import { staffTenantCosts } from "./tenant-costs";
import { staffModelRouting } from "./model-routing";
import { staffBuildCosts } from "./build-costs";
import { staffCsat } from "./csat";
import { staffBrainMetrics } from "./brain-metrics";
import { staffGaps, staffOperatorFailureShapes } from "./gaps";
import { staffErrors } from "./errors";
import { staffCrons } from "./crons";
import { staffConnectorsHealth } from "./connectors-health";
import { staffAgentQuality } from "./agent-quality";
import { staffBuildQuality } from "./build-quality";
import { staffAgentPerformance } from "./agent-performance";
import { staffStuckRuns } from "./stuck-runs";
import { staffAuditLog } from "./audit-log";
import { staffTenantHealth } from "./tenant-health";
import { staffCohorts } from "./cohorts";
import { staffNotificationsLog } from "./notifications-log";
import { staffAnnouncements } from "./announcements";
import { staffFeatureFlags } from "./feature-flags";
import {
  staffGatekeeperCheck,
  staffGatekeeperCreate,
  staffGatekeeperDelete,
  staffGatekeeperGet,
  staffGatekeeperList,
  staffGatekeeperToggle,
  staffGatekeeperUpdate,
} from "./gatekeeper";
import { staffSlackWorkspaces } from "./slack-workspaces";
import { staffCostAnomaly } from "./cost-anomaly";
import { staffGlobalSearch } from "./search";
import { staffOnboardingPipeline } from "./onboarding-pipeline";
import { staffMeetingsOps } from "./meetings-ops";
import { staffMembers } from "./members";
import { staffBilling } from "./billing";
import { staffAffiliatePayoutApprove, staffAffiliatePayoutRecord, staffAffiliatePayoutReject, staffAffiliatePayoutRelease, staffAffiliatePayouts, staffAffiliateReversalRecord, staffAffiliateReversalRelease, staffAffiliateInboxReplay, staffAffiliateExternalReversal } from "./affiliates";
import { staffRevenue } from "./revenue";
import { staffDisputes } from "./disputes";
import {
  staffCreditGrantsList,
  staffCreditGrant,
  staffCreditGrantRevoke,
  staffCreditUnlimitedSet,
} from "./credit-grant";
import { staffDoctorStatus } from "./doctor-status";
import { staffUsageLimitStatus } from "./usage-limit-status";
import { staffFunnel } from "./funnel";
import { staffSignupCreditCosts } from "./signup-credit-costs";
import { staffOnboardingFunnel } from "./onboarding-funnel";
import { staffOnboardingEmailsStats } from "./onboarding-emails-stats";
import { staffValueReport } from "./value-report";
import { staffActivation } from "./activation";
import { staffActivity } from "./activity";
import { staffActionTracker } from "./action-tracker";
import { staffList } from "./staff-list";
import {
  staffSuperUsersList,
  staffSuperUsersCandidates,
  staffSuperUsersGrant,
  staffSuperUsersRevoke,
} from "./super-users";
import { staffConfigGet, staffConfigPatch } from "./config";
import { staffCreditTierImpact } from "./credit-tier-impact";
import {
  staffChannelLocksGet,
  staffChannelLockImpact,
  staffChannelLockSet,
} from "./channel-locks";
import { staffSettingsGet, staffSettingsPut } from "./settings";
import { staffSiteBackendSettingsGet, staffSiteBackendSettingsPut, staffSiteGraduate, staffSiteGraduation } from "./site-backend-settings";
import { staffSiteShardsAutoProvisioning, staffSiteShardsList, staffSiteShardsProvision, staffSiteShardsRecover } from "./site-shards";
import { staffCgoAutopilotGet } from "./cgo-autopilot";
import { staffBuildReplayGet } from "./build-replay";
import {
  staffAgentVisibilityGet,
  staffAgentVisibilityPost,
} from "./agent-visibility";
import {
  staffTenantVisibilityGet,
  staffTenantVisibilityPost,
} from "./agent-visibility-tenant";
import {
  staffEngineOverrideGet,
  staffEngineOverrideSet,
  staffEngineOverrideClear,
  staffEngineOverrideMasterKill,
} from "./engine-override";
import {
  staffEngineVariantsList,
  staffEngineVariantsUpsert,
  staffEngineVariantsDelete,
  staffEngineVariantsAssign,
  staffEngineVariantsGlobal,
} from "./engine-variants";
import { staffLocalLaneGet, staffLocalLaneSet, staffLocalLaneEnable } from "./local-lane";
import {
  staffRetentionPolicyGet,
  staffRetentionPolicySet,
} from "./retention-policy";
import { staffSlackW2KillswitchPost } from "./slack-w2-killswitch";
import { staffFleetHaltGet, staffFleetHaltPost } from "./fleet-halt";
import { adminScriptRunGet, adminScriptRunPost, adminScriptsList, scriptUploadMiddleware } from "./scripts";
import { staffCardLabelsNext, staffCardLabelsSave, staffCardLabelsCreateBatch } from "./card-labels";
import { staffErasureSlackPost } from "./erasure-slack";
import {
  staffTrainerQueueList,
  staffTrainerDecisionApprove,
  staffTrainerDecisionReject,
} from "./trainer-queue";
import {
  staffDreamCandidatesList,
  staffDreamCandidateApprove,
  staffDreamCandidateReject,
} from "./dream-candidates";
import {
  staffRoutineCandidatesList,
  staffRoutineCandidateApprove,
  staffRoutineCandidateReject,
} from "./routine-candidates";
import {
  staffGlobalRulesList,
  staffGlobalRulesPropose,
  staffGlobalRulesApprove,
} from "./global-rules";
import { staffBrainEvalExport, staffBrainEvalReplay } from "./brain-eval";
import { staffRegressionList, staffRegressionArm } from "./regression";
import { staffTakesScorecard } from "./takes-scorecard";
import { staffMetaAdsCapsGet, staffMetaAdsCapsPost } from "./meta-ads-caps";
import {
  staffAdminTasksList,
  staffAdminTaskClaim,
  staffAdminTaskSnooze,
  staffAdminTaskResolve,
  staffAdminTaskDismiss,
  staffAdminTaskEnrichMemory,
} from "./admin-tasks";
import {
  staffHumanActionsList,
  staffHumanActionsCreate,
  staffHumanActionsStatus,
  staffHumanActionsSetGoal,
} from "./human-actions";
import {
  staffSuggestionsGenerate,
  staffSuggestionsCreate,
  staffSuggestionsPatch,
  staffSuggestionsArchive,
  staffSuggestionPush,
  staffSuggestionsPushBatch,
  staffSuggestionSessionsList,
  staffSuggestionSessionGet,
} from "./suggestions";
import { staffSuggestionsContext } from "./client-context";
import {
  staffCompanyFieldsFillStart,
  staffCompanyFieldsFillStatus,
  staffCompanyFieldsPublish,
} from "./company-fields";
import {
  staffCompetitorProfilePublish,
  staffCompetitorResearchStart,
  staffCompetitorResearchStatus,
} from "./competitor-profiles";
import {
  staffCompanyProfilePublish,
  staffCompanyResearchStart,
  staffCompanyResearchStatus,
} from "./company-profiles";

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adminRouter(): Router {
  const r = forwardAsyncErrors(Router());

  r.use(staffMiddleware());

  r.param("tenant_id", (_req, res, next, val) => {
    if (typeof val !== "string" || !TENANT_UUID_RE.test(val)) {
      res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a UUID" } });
      return;
    }
    next();
  });

  r.get("/whoami", (req, res) => {
    const s = assertStaff(req);
    res.json({ user_id: s.user_id, email: s.email });
  });

  r.get("/humans", staffHumanQueue);
  r.get("/humans/:id", staffHumanDetail);
  r.patch("/humans/:id/vetting", staffHumanSetVetting);

  r.get("/creator-disputes", staffCreatorDisputeQueue);
  r.get("/creator-disputes/:id", staffCreatorDisputeDetail);
  r.post("/creator-disputes/:id/resolve", staffCreatorDisputeResolve);
  r.get("/creators/:id", staffCreatorDetail);
  r.post("/creators/:id/remove", staffCreatorRemove);

  r.get("/admin-tasks", staffAdminTasksList);
  r.post("/admin-tasks/:id/claim", staffAdminTaskClaim);
  r.post("/admin-tasks/:id/snooze", staffAdminTaskSnooze);
  r.post("/admin-tasks/:id/resolve", staffAdminTaskResolve);
  r.post("/admin-tasks/:id/dismiss", staffAdminTaskDismiss);
  r.post("/admin-tasks/:id/enrich-memory", staffAdminTaskEnrichMemory);

  r.get("/human-actions", staffHumanActionsList);
  r.post("/human-actions", staffHumanActionsCreate);
  r.post("/human-actions/:id/status", staffHumanActionsStatus);
  r.post("/tenants/:tenant_id/goal", staffHumanActionsSetGoal);

  r.get("/suggestions/context", staffSuggestionsContext);
  r.get("/suggestions/sessions", staffSuggestionSessionsList);
  r.get("/suggestions/sessions/:id", staffSuggestionSessionGet);
  r.post("/suggestions/generate", staffSuggestionsGenerate);
  r.post("/suggestions", staffSuggestionsCreate);
  r.post("/suggestions/push-batch", staffSuggestionsPushBatch);
  r.patch("/suggestions/:id", staffSuggestionsPatch);
  r.post("/suggestions/:id/push", staffSuggestionPush);
  r.post("/suggestions/:id/archive", staffSuggestionsArchive);

  r.get("/readiness", staffReadinessBoard);
  r.post("/fde-action", staffFdeAction);
  r.get("/fde-folds", staffFdeFolds);
  r.post("/fde-folds/:id/decide", staffFdeFoldDecide);

  r.get("/tenants-growth", staffTenantsGrowth);
  r.post("/tenants-growth/classify", staffClassifyGrowthAccounts);
  r.get("/tenants", staffTenants);
  r.post("/login-as", staffLoginAs);
  r.get("/user-lookup", staffUserLookup);
  r.get("/tenants-usage", staffTenantsUsage);
  r.get("/tenants/:tenant_id", staffTenantSummary);
  r.post("/tenants/:tenant_id/kind", staffSetTenantKind);
  r.post("/tenants/:tenant_id/disabled", staffSetTenantDisabled);
  r.post("/tenants/:tenant_id/plan", staffSetTenantPlan);
  r.get("/tenants/:tenant_id/agents", staffTenantAgents);
  r.get("/tenants/:tenant_id/agent-health", staffTenantAgentHealth);
  r.get("/tenants/:tenant_id/coverage-map", staffTenantCoverageMap);
  r.post("/tenants/:tenant_id/coach/set-goal", staffCoachSetGoal);
  r.get("/tenants/:tenant_id/runs", staffTenantRuns);
  r.get("/tenants/:tenant_id/readiness", staffTenantReadiness);
  r.get("/tenants/:tenant_id/fde-events", staffTenantFdeEvents);
  r.post("/tenants/:tenant_id/fde-dispatch", staffFdeDispatch);
  r.get("/tenants/:tenant_id/brain/drafts", staffBrainDrafts);
  r.post("/tenants/:tenant_id/brain/promote", staffBrainPromote);
  r.get("/tenants/:tenant_id/needs-help", staffTenantNeedsHelp);
  r.get("/tenants/:tenant_id/decisions", staffTenantDecisions);
  r.get("/tenants/:tenant_id/feedback", staffTenantFeedback);
  r.get("/tenants/:tenant_id/profile", staffTenantProfile);
  r.get("/tenants/:tenant_id/company-facts", staffCompanyFactsGet);
  r.post("/tenants/:tenant_id/company-facts", staffCompanyFactsSet);
  r.post("/tenants/:tenant_id/company-facts/suggest", staffCompanyFactsSuggest);
  r.post("/tenants/:tenant_id/competitors/research", staffCompetitorResearchStart);
  r.get(
    "/tenants/:tenant_id/competitors/research/:run_id",
    staffCompetitorResearchStatus,
  );
  r.post("/tenants/:tenant_id/competitors", staffCompetitorProfilePublish);
  r.post("/tenants/:tenant_id/company-profile/research", staffCompanyResearchStart);
  r.get(
    "/tenants/:tenant_id/company-profile/research/:run_id",
    staffCompanyResearchStatus,
  );
  r.post("/tenants/:tenant_id/company-profile", staffCompanyProfilePublish);
  r.post("/tenants/:tenant_id/company-fields/fill", staffCompanyFieldsFillStart);
  r.get("/tenants/:tenant_id/company-fields/fill/:run_id", staffCompanyFieldsFillStatus);
  r.post("/tenants/:tenant_id/company-fields", staffCompanyFieldsPublish);
  r.get("/tenants/:tenant_id/activity", staffTenantActivity);
  r.get("/tenants/:tenant_id/credits", staffTenantCredits);
  r.get("/tenants/:tenant_id/credits/ledger", staffTenantCreditLedger);
  r.post("/tenants/:tenant_id/agents/:slug/note", staffTenantAgentNote);

  r.post("/tenants/:tenant_id/agents/:slug/chat", staffAgentChat);
  r.get("/tenants/:tenant_id/agents/:slug/threads/:thread_id", staffAgentThreadRead);
  r.post("/tenants/:tenant_id/decisions/:decision_id/execute", staffDecisionExecute);

  r.get("/tenants/:tenant_id/threads", staffTenantThreadList);
  r.get("/tenants/:tenant_id/threads/:thread_id", staffTenantThreadRead);

  r.post("/tenants/:tenant_id/agents/:slug/bake", staffTenantAgentBake);

  r.get("/feedback", staffFeedbackFirehose);
  r.get("/product-feedback", staffProductFeedbackList);
  r.patch("/product-feedback/:id", staffProductFeedbackUpdate);
  r.get("/team-notes/summary", staffTeamNotesSummary);
  r.get("/team-notes/reports", staffTeamReportList);
  r.get("/team-notes/reports/:id", staffTeamReportRead);
  r.get("/runs", staffRunsFirehose);
  r.get("/runs/:run_id", staffRunDetail);
  r.post("/runs/:run_id/review", staffRunReviewWrite);
  r.get("/runs/:run_id/review", staffRunReviewList);
  r.get("/judge-calibration", staffJudgeCalibration);
  r.post("/runs/:run_id/retry", staffRunRetry);
  r.post("/first-plan-backfill", staffFirstPlanBackfill);
  r.get("/runs/:run_id/recall-trace", staffRunRecallTrace);
  r.get("/memory/write-metrics", staffMemoryWriteMetrics);
  r.get("/runs/:run_id/trace", staffRunTrace);

  r.post("/feedback", staffFeedbackWrite);

  r.get("/decisions", staffDecisionsFirehose);
  r.get("/decisions/:id", staffDecisionDetail);
  r.post("/decisions/:decision_id/decide", staffDecisionDecide);
  r.get("/memory", staffMemoryList);
  r.get("/agents", staffAgentsFirehose);

  r.get("/stats", staffStats);
  r.get("/overview", staffOverview);
  r.get("/costs", staffCosts);
  r.get("/tenant-costs", staffTenantCosts);
  r.get("/model-routing", staffModelRouting);
  r.get("/build-costs", staffBuildCosts);
  r.get("/csat", staffCsat);
  r.get("/brain-metrics", staffBrainMetrics);
  r.get("/gaps", staffGaps);
  r.get("/operator-failure-shapes", staffOperatorFailureShapes);
  r.get("/errors", staffErrors);
  r.get("/crons", staffCrons);
  r.get("/connectors-health", staffConnectorsHealth);
  r.get("/agent-quality", staffAgentQuality);
  r.get("/build-quality", staffBuildQuality);
  r.get("/agent-performance", staffAgentPerformance);
  r.get("/stuck-runs", staffStuckRuns);
  r.get("/audit-log", staffAuditLog);
  r.get("/tenant-health", staffTenantHealth);
  r.get("/cohorts", staffCohorts);
  r.get("/notifications-log", staffNotificationsLog);
  r.get("/announcements", staffAnnouncements);
  r.get("/feature-flags", staffFeatureFlags);
  r.get("/gatekeeper/flags", staffGatekeeperList);
  r.get("/gatekeeper/flags/:name", staffGatekeeperGet);
  r.post("/gatekeeper/flags", staffGatekeeperCreate);
  r.put("/gatekeeper/flags/:name", staffGatekeeperUpdate);
  r.patch("/gatekeeper/flags/:name/toggle", staffGatekeeperToggle);
  r.delete("/gatekeeper/flags/:name", staffGatekeeperDelete);
  r.get("/gatekeeper/check/:name", staffGatekeeperCheck);
  r.get("/slack-workspaces", staffSlackWorkspaces);
  r.get("/cost-anomaly", staffCostAnomaly);
  r.get("/search", staffGlobalSearch);
  r.get("/onboarding-pipeline", staffOnboardingPipeline);
  r.get("/meetings-ops", staffMeetingsOps);
  r.get("/members", staffMembers);
  r.get("/billing", staffBilling);
  r.get("/affiliates/payouts", staffAffiliatePayouts);
  r.post("/affiliates/payouts/:id/approve", staffAffiliatePayoutApprove);
  r.post("/affiliates/payouts/:id/reject", staffAffiliatePayoutReject);
  r.post("/affiliates/payouts/:id/record", staffAffiliatePayoutRecord);
  r.post("/affiliates/payouts/:id/release", staffAffiliatePayoutRelease);
  r.post("/affiliates/reversals/:id/record", staffAffiliateReversalRecord);
  r.post("/affiliates/reversals/:id/release", staffAffiliateReversalRelease);
  r.post("/affiliates/inbox/:event_id/replay", staffAffiliateInboxReplay);
  r.post("/affiliates/payouts/:id/external-reversal", staffAffiliateExternalReversal);
  r.get("/revenue", staffRevenue);
  r.get("/disputes", staffDisputes);
  r.get("/credit-grants", staffCreditGrantsList);
  r.post("/credit-grant", staffCreditGrant);
  r.post("/credit-grant/revoke", staffCreditGrantRevoke);
  r.post("/credit-unlimited", staffCreditUnlimitedSet);
  r.get("/doctor-status", staffDoctorStatus);
  r.get("/usage-limit-status", staffUsageLimitStatus);

  r.get("/funnel", staffFunnel);
  r.get("/funnel/credits", staffSignupCreditCosts);
  r.get("/onboarding-funnel", staffOnboardingFunnel);
  r.get("/onboarding-emails-stats", staffOnboardingEmailsStats);
  r.get("/value-report", staffValueReport);
  r.get("/activation", staffActivation);
  r.get("/activity", staffActivity);
  r.get("/action-tracker", staffActionTracker);
  r.get("/allowlist", staffList);
  r.get("/super-users", staffSuperUsersList);
  r.get("/super-users/candidates", staffSuperUsersCandidates);
  r.post("/super-users/grant", staffSuperUsersGrant);
  r.post("/super-users/revoke", staffSuperUsersRevoke);
  r.get("/config", staffConfigGet);
  r.patch("/config", staffConfigPatch);
  r.post("/credit-tiers/impact", staffCreditTierImpact);
  r.get("/settings", staffSettingsGet);
  r.put("/settings", staffSettingsPut);
  r.get("/cgo-autopilot", staffCgoAutopilotGet);
  r.get("/build-replay", staffBuildReplayGet);

  r.get("/channel-locks", staffChannelLocksGet);
  r.get("/channel-locks/:slug/impact", staffChannelLockImpact);
  r.post("/channel-locks/:slug", staffChannelLockSet);
  r.get("/sites/:site_id/backend-settings", staffSiteBackendSettingsGet);
  r.put("/sites/:site_id/backend-settings", staffSiteBackendSettingsPut);
  r.post("/sites/:site_id/graduate", staffSiteGraduate);
  r.get("/sites/:site_id/graduation", staffSiteGraduation);
  r.get("/site-shards", staffSiteShardsList);
  r.post("/site-shards/provision", staffSiteShardsProvision);
  r.post("/site-shards/auto-provisioning", staffSiteShardsAutoProvisioning);
  r.post("/site-shards/recover", staffSiteShardsRecover);

  r.get("/agent-visibility", staffAgentVisibilityGet);
  r.post("/agent-visibility", staffAgentVisibilityPost);

  r.get("/agent-visibility/tenant", staffTenantVisibilityGet);
  r.post("/agent-visibility/tenant", staffTenantVisibilityPost);

  r.get("/engine-override", staffEngineOverrideGet);
  r.post("/engine-override", staffEngineOverrideSet);
  r.delete("/engine-override", staffEngineOverrideClear);
  r.post("/engine-override/master-kill", staffEngineOverrideMasterKill);

  r.get("/engine-variants", staffEngineVariantsList);
  r.post("/engine-variants", staffEngineVariantsUpsert);
  r.delete("/engine-variants", staffEngineVariantsDelete);
  r.post("/engine-variants/assign", staffEngineVariantsAssign);
  r.post("/engine-variants/global", staffEngineVariantsGlobal);

  r.get("/local-lane", staffLocalLaneGet);
  r.post("/local-lane", staffLocalLaneSet);
  r.post("/local-lane/enable", staffLocalLaneEnable);

  r.get("/retention-policy", staffRetentionPolicyGet);
  r.post("/retention-policy", staffRetentionPolicySet);

  r.post("/slack-w2/killswitch", staffSlackW2KillswitchPost);

  r.get("/fleet-halt", staffFleetHaltGet);
  r.post("/fleet-halt", staffFleetHaltPost);

  r.get("/scripts", adminScriptsList);
  r.get("/scripts/runs/:id", adminScriptRunGet);
  r.post("/scripts/:key/run", scriptUploadMiddleware, adminScriptRunPost);

  r.get("/card-labels/next", staffCardLabelsNext);
  r.post("/card-labels/batch", staffCardLabelsCreateBatch);
  r.post("/card-labels/:batch_id/:action_id", staffCardLabelsSave);

  r.post("/erasure/slack", staffErasureSlackPost);

  r.get("/trainer-queue", staffTrainerQueueList);
  r.post("/trainer-queue/decisions/:id/approve", staffTrainerDecisionApprove);
  r.post("/trainer-queue/decisions/:id/reject", staffTrainerDecisionReject);

  r.get("/dream-candidates", staffDreamCandidatesList);
  r.post("/dream-candidates/:id/approve", staffDreamCandidateApprove);
  r.post("/dream-candidates/:id/reject", staffDreamCandidateReject);

  r.get("/routine-candidates", staffRoutineCandidatesList);
  r.post("/routine-candidates/:id/approve", staffRoutineCandidateApprove);
  r.post("/routine-candidates/:id/reject", staffRoutineCandidateReject);

  r.get("/global-rules", staffGlobalRulesList);
  r.post("/global-rules", staffGlobalRulesPropose);
  r.post("/global-rules/:id/approve", staffGlobalRulesApprove);

  r.post("/brain-eval/export", staffBrainEvalExport);
  r.post("/brain-eval/replay", staffBrainEvalReplay);

  r.get("/regression/signatures", staffRegressionList);
  r.post("/regression/signatures/arm", staffRegressionArm);

  r.get("/takes/scorecard", staffTakesScorecard);

  r.get("/meta-ads/caps", staffMetaAdsCapsGet);
  r.post("/meta-ads/caps", staffMetaAdsCapsPost);

  return r;
}
