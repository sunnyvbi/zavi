import { adsWalletBatchFn, chatgptAdsWalletFn } from "./chatgpt-ads-wallet";
import { adsCampaignOperationsFn } from "./ads-campaign-operations";

import { runAgentFn, runAgentInteractiveFn } from "./run-agent";
import { cleanupOauthStatesFn } from "./cleanup-oauth-states";
import { expireCompPlansFn } from "./expire-comp-plans";
import {
  metaAdsTokenHealthFn,
  metaAdsTokenInvalidFn,
  metaAdsDeauthorizedFn,
} from "./meta-ads-token-health";
import { cleanupSyntheticThreadsFn } from "./cleanup-synthetic-threads";
import { transcriptRetentionPurgeFn, dbRetentionContinueFn, dbCleanupPurgeFn } from "./transcript-retention-purge";
import { accountDeletionPurgeFn } from "./account-deletion-purge";
import { inngestCapacityWatchFn } from "./inngest-capacity-watch";
import { autoTitleThreadsFn } from "./auto-title-threads";
import { scheduledRunsFn } from "./scheduled-runs";
import { reminderWaitFn, reminderSweepFn } from "./reminder-fire";
import {
  creatorDeadlineWaitFn,
  creatorPayoutBufferWaitFn,
  creatorDeadlineSweepFn,
} from "./creator-deadline-fire";
import { affiliateEventRetryFn, affiliatePayoutsFn } from "./affiliate-payouts";
import {
  creatorBriefAnswerByWaitFn,
  creatorBriefAnswerBySweepFn,
} from "./creator-brief-answer-by";
import {
  creatorRightsExpiryWaitFn,
  creatorRightsExpirySweepFn,
} from "./creator-rights-expiry";
import { creatorLibraryMetricsSweepFn } from "./creator-library-metrics";
import { creatorCountryNeededWaitFn } from "./creator-country-needed";
import { signupFollowupWaitFn } from "./signup-followup";
import { planReadyEmailWaitFn } from "./plan-ready-email";
import { creatorIllustrationFn } from "./creator-illustration";
import { creatorSubmissionPreviewFn } from "./creator-submission-preview";
import { creatorBookingLinkFn } from "./creator-booking-link";
import { scoreRunsFn } from "./score-runs";
import { negExistenceGroundFn } from "./neg-existence-ground";
import { queuedStuckScanFn } from "./queued-stuck-scan";
import { staleRunReaperFn } from "./stale-run-reaper";
import { conductorTickFn, conductorTickRequestedFn } from "./conductor-tick";
import { buildScreenCheckFn } from "./build-screen-check";
import { siteThumbnailFn } from "./site-thumbnail";
import { sitePreviewSnapshotFn } from "./site-preview-snapshot";
import { buildStaticPublishFn } from "./build-static-publish";
import { siteActivateFn } from "./site-activate";
import { idleCoachScanFn } from "./idle-coach-scan";
import { dispatchDecisionFn, dispatchAutoCronFn } from "./dispatch-decision";
import { dispatchChannelActionFn } from "./dispatch-channel-action";
import { reconcileChannelActionExecFn, reconcileDecisionEmailSendFn } from "./reconcile-channel-action-exec";
import { opsAlertOutboxDrainFn } from "./ops-alert-outbox-drain";
import { teamReportPingsDrainFn } from "./team-report-pings-drain";
import { distillSlackEventFn } from "./distill-event";
import { slackMessageLifecycleFn } from "./slack-message-lifecycle";
import { slackTriageFn } from "./slack-triage";
import { slackTriageReplyFn } from "./slack-triage-reply";
import { slackOutboxDrainerFn } from "./slack-outbox-drainer";
import { slackOutboxPurgeFn } from "./slack-outbox-purge";
import { emailTriageFn } from "./email-triage";
import { emailTriageReplyFn } from "./email-triage-reply";
import { teamsTriageReplyFn } from "./teams-triage-reply";
import { telegramTriageReplyFn } from "./telegram-triage-reply";
import { discordTriageReplyFn } from "./discord-triage-reply";
import { setupDraftRefundOnCompleteFn, setupDraftRefundOnFailFn } from "./setup-draft-refund";
import { cgoGoalOwnerFn, cgoNoteEmailFn } from "./cgo-goal-owner";
import { founderOrderAdviceFn } from "./founder-order-advice";
import { chatCardDeliverFn } from "./chat-card-deliver";
import { cgoAnswersWakeFn } from "./cgo-answers-wake";
import { cgoDailyCheckFn } from "./cgo-daily-check";
import { onboardingEmailSweepFn } from "./onboarding-email-sweep";
import { adBudgetReconcileFn, adBudgetReconnectReadFn } from "./ad-budget-reconcile";
import { liveStuntDraftFn, liveStuntSnapshotFn } from "./live-stunt";
import { cgoBudgetReviewFn } from "./cgo-budget-review";
import { adSpendControllerFn } from "./ad-spend-controller";
import { knowledgeImportReadFn } from "./knowledge-import-read";
import { whatsappTriageReplyFn } from "./whatsapp-triage-reply";
import { imessageTriageReplyFn } from "./imessage-triage-reply";
import { distillChatTurnFn } from "./distill-chat-turn";
import { ruleSuggestChatFn } from "./rule-suggest-chat";
import { teamNoteJudgeFn } from "./team-note-judge";
import { distillAgentRunFn } from "./distill-agent-run";
import { previewUpgradeRerunFn } from "./preview-upgrade-rerun";
import { persistRunTraceFn } from "./persist-run-trace";
import { agentTraceGcFn } from "./agent-trace-gc";
import { teamReportsGcFn } from "./team-reports-gc";
import { customDomainVerifySweepFn } from "./custom-domain-verify-sweep";
import { loopClosureAuditFn } from "./loop-closure-audit";
import { distillBackfillFn } from "./distill-backfill";
import { distillRoutineCandidateFn } from "./distill-routine-candidate";
import { distillSkillCandidateFn } from "./distill-skill-candidate";
import { dreamCycleFn, dreamCycleTenantFn } from "./dream-cycle";
import { pingFn } from "./ping";
import { bulkEmailFanoutFn } from "./bulk-email-fanout";
import { emailSendOutcomeTellFn } from "./email-send-outcome-tell";
import { xOrganicTrialsFn } from "./x-organic-trials";
import { emailResultsCheckFn } from "./email-results-check";
import { emailPlanTickFn } from "./email-plan-tick";
import { memoryEnrichmentFn } from "./memory-enrichment";
import { autoProvisionTenantFn } from "./auto-provision-tenant";
import { bootstrapAnchorsFn } from "./bootstrap-anchors";
import { cleanupStaleOnboardingDraftsFn } from "./cleanup-stale-onboarding-drafts";
import { onboardingScanFn } from "./onboarding-scan";
import { onboardingWebsiteMemoryFn } from "./onboarding-website-memory";
import { pollTrackerCommentsFn } from "./poll-tracker-comments";
import { agentLearnWeeklyFn } from "./agent-learn-weekly";
import { agentCsatRollupFn } from "./agent-csat-rollup";
import { bookingRollupRefreshFn } from "./booking-rollup-refresh";
import { outcomeRollupRefreshFn, outcomeRollupSweepFn } from "./outcome-rollup-refresh";
import { teamDiscoverFn } from "./team-discover";
import { chatImageStaleSweepFn } from "./chat-image-stale-sweep";
import { hostingIdleReaperFn } from "./hosting-idle-reaper";
import { siteIdleSweepFn } from "./site-idle-sweep";
import {
  patternsNightlyScannerFn,
  patternsNightlyHandlerFn,
} from "./patterns-nightly";
import { growthOrchestratorDailyFn } from "./growth-lead-daily";
import { channelSweepFn } from "./channel-sweep";
import { vendorUsageReconcileFn } from "./vendor-usage";
import { perfmktPulseFn } from "./perfmkt-pulse";
import {
  memoryRecallCanaryFn,
  memoryRecallEvalFn,
} from "./memory-recall-canary";
import { runFailureRateCanaryFn } from "./run-failure-rate-canary";
import { scheduledDeliverySloFn } from "./scheduled-delivery-slo";
import { slackDeliveryFailureCanaryFn } from "./slack-delivery-failure-canary";
import { slackDeliveryCanaryFn } from "./slack-delivery-canary";
import { regressionMintFn } from "./regression-mint";
import { sitePrSettleFn } from "./site-pr-settle";
import { selfHealScanFn } from "./self-heal-scan";
import { planCriticFn } from "./plan-critic";
import { workQueueDrainerFn } from "./work-queue-drainer";
import { memorySignalBackfillFn } from "./memory-signal-backfill";
import { memorySignalGcFn } from "./memory-signal-gc";
import { memoryStaleNoteArchiveFn } from "./memory-stale-note-archive";
import {
  memoryForgetPurgeFn,
  memoryWriteMaintenanceFn,
  memoryWriteDailyFn,
} from "./memory-write-maintenance";
import { memoryCleanupRequestedFn, memoryCleanupTenantFn } from "./memory-dedup-cleanup";
import { memoryOutcomeStampFn } from "./memory-outcome-stamp";
import { memoryGapDistillFn } from "./memory-gap-distill";
import { batchFanoutWorktreeReaperFn } from "./batch-fanout-worktree-reaper";
import { batchFanoutRefundReconcilerFn } from "./batch-fanout-refund-reconciler";
import { handoffBatchJoinFn } from "./handoff-batch-join";
import { askChildCompletedFn, askDeadlineFn, askSweepFn } from "./ask-agent";
import { customAgentHandoffJoinFn } from "./custom-agent-handoff-join";
import { voiceSidecarHealthPingFn } from "./voice-sidecar-health-ping";
import { voiceCallbackEventsCleanupFn } from "./voice-callback-events-cleanup";
import { praxisDoctorCronFn } from "./praxis-doctor-cron";
import { slackAutoJoinFn } from "./slack-auto-join";
import { slackWelcomeFn } from "./slack-welcome";
import { slackEnsureDigestChannelFn } from "./slack-ensure-digest-channel";
import { slackChannelIntroFn } from "./slack-channel-intro";
import {
  slackTailoredOnboardingStartFn,
  slackTailoredOnboardingCompleteFn,
} from "./slack-tailored-onboarding";
import {
  slackChannelSummarizeSchedulerFn,
  slackChannelSummarizeTenantFn,
} from "./slack-channel-summarize";
import { lowConfDispatchSweepFn } from "./low-conf-dispatch-sweep";
import { operatorFollowthroughSweepFn } from "./operator-followthrough-sweep";
import { strategistReviewSweepFn } from "./strategist-review-sweep";
import { slackMessageIndexPruneFn } from "./slack-message-index-prune";
import { memoryNoteEnrichFn } from "./memory-note-enrich";
import { slackW2PurgeFn } from "./slack-w2-purge";
import {
  slackChannelMembersRefreshSchedulerFn,
  slackChannelMembersRefreshTenantFn,
} from "./slack-channel-members-refresh";
import { provisioningReconcileFn } from "./provisioning-reconcile";
import { provisioningDeployPollFn } from "./provisioning-deploy-poll";
import { approvalSlackNotifyFn } from "./approval-slack-notify";
import { approvalStrandProbeFn } from "./approval-strand-probe";
import { slackBatchDecideFn } from "./slack-batch-decide";
import { slackNlRouteFn } from "./slack-nl-route";
import { goalReconcileFn } from "./goal-reconcile";
import { engineerPostdeployVerifyFn } from "./engineer-postdeploy-verify";
import { engineerPrCiReadbackFn } from "./engineer-pr-ci-readback";
import { autopilotWaiverExpireFn } from "./autopilot-waiver-expire";
import { refineSuggestionScanFn } from "./refine-suggestion-scan";
import { infraReaperFn } from "./infra-reaper";
import { siteReaperFn } from "./site-reaper";
import { siteShardsMaintenanceFn } from "./site-shards-maintenance";
import { siteFunctionsSchedulerFn, siteFunctionsRunBatchFn, siteFunctionsSweeperFn } from "./site-functions";
import { siteFormNotifyFn } from "./site-form-notify";
import { siteShardsMetricsFn } from "./site-shards-metrics";
import { siteShardProvisionFn } from "./site-shard-provision";
import { siteShardsSchemaRolloutFn } from "./site-shards-schema-rollout";
import { siteReconcileFn } from "./site-reconcile";
import { previewReaperFn } from "./preview-reaper";
import { launchVideoPublicReaperFn } from "./launch-video-public-reaper";
import { startCardFn, startCardQueueDrainFn, startCardTenantSettleFn, startCardTenantSettleSweepFn } from "./start-card";
import { reapStaleBrowserSessionsFn } from "./reap-stale-browser-sessions";
import { outboundSequenceTickFn } from "./outbound-sequence-tick";
import { reconcileActionOutcomesFn } from "./reconcile-action-outcomes";
import { repoProfileBuildFn } from "./repo-profile-build";
import { operatorDbDiscoverFn } from "./operator-db-discover";
import {
  bookingMappingDetectFn,
  bookingMappingBackfillFn,
} from "./booking-mapping-detect";
import { repoConventionsDistillFn } from "./repo-conventions-distill";
import { qaWeeklyExecuteFn } from "./qa-weekly-execute";
import { competitorIntelWeeklyFn } from "./competitor-intel-weekly";
import { materialNewsScanFn } from "./material-news-scan";
import { materialNewsDigestFn } from "./material-news-digest";
import { mentionAlertSendFn } from "./mention-alert-send";
import { engineerAuditWeeklyFn } from "./engineer-audit-weekly";
import { nightlySelfImproveFn } from "./nightly-self-improve";
import { decisionsAutoExpireFn } from "./decisions-auto-expire";
import { readinessScanFn } from "./readiness-scan";
import { brainJudgeScanFn } from "./brain-judge-scan";
import { goalProposerScanFn } from "./goal-proposer-scan";
import { fdeFoldScanFn } from "./fde-fold-scan";
import { shadowCanaryCronFn } from "./shadow-canary-cron";
import { meetingBotSchedulerFn } from "./meeting-bot-scheduler";
import { meetingProcessFn, meetingAtomsExpireFn, meetingNotesRetentionFn } from "./meeting-process";
import { meetingReconcileFn } from "./meeting-reconcile";
import { meetingNoticeFn } from "./meeting-notice";
import { autopilotRemitSweepFn } from "./autopilot-remit-sweep";
import { fundraisingRunAngelRoundFn } from "./fundraising-run-angel-round";
import { socialPublishFn } from "./social-publish";
import { tiktokPublishFn } from "./tiktok-publish";
import { renderLaunchVideoFn } from "./render-launch-video";
import { generateChannelVideoFn, generateVideoFn } from "./generate-video";
import { companyBrainHeartbeatFn } from "./company-brain-heartbeat";
import { marketplaceRollupFn, marketplaceRollupRequestedFn } from "./marketplace-rollup";
import { deployTruthPollFn } from "./deploy-truth-poll";
import { metricSweepFn } from "./metric-sweep";
import { geoPromptSweepFn } from "./geo-prompt-sweep";
import { redditSweepFn, redditSweepCronFn } from "./reddit-sweep";

export const inngestFunctions = [
  chatgptAdsWalletFn,
  adsWalletBatchFn,
  adsCampaignOperationsFn,
  runAgentFn,
  runAgentInteractiveFn,
  meetingBotSchedulerFn,
  meetingProcessFn,
  meetingAtomsExpireFn,
  meetingNotesRetentionFn,
  meetingReconcileFn,
  meetingNoticeFn,
  cleanupOauthStatesFn,
  expireCompPlansFn,
  metaAdsTokenHealthFn,
  metaAdsTokenInvalidFn,
  metaAdsDeauthorizedFn,
  cleanupSyntheticThreadsFn,
  transcriptRetentionPurgeFn,
  dbRetentionContinueFn,
  dbCleanupPurgeFn,
  accountDeletionPurgeFn,
  inngestCapacityWatchFn,
  autoTitleThreadsFn,
  scheduledRunsFn,
  reminderWaitFn,
  reminderSweepFn,
  creatorDeadlineWaitFn,
  creatorPayoutBufferWaitFn,
  creatorDeadlineSweepFn,
  affiliatePayoutsFn,
  affiliateEventRetryFn,
  creatorBriefAnswerByWaitFn,
  creatorBriefAnswerBySweepFn,
  creatorRightsExpiryWaitFn,
  creatorRightsExpirySweepFn,
  creatorLibraryMetricsSweepFn,
  creatorCountryNeededWaitFn,
  signupFollowupWaitFn,
  planReadyEmailWaitFn,
  creatorIllustrationFn,
  creatorSubmissionPreviewFn,
  creatorBookingLinkFn,
  queuedStuckScanFn,
  staleRunReaperFn,
  conductorTickFn,
  conductorTickRequestedFn,
  buildScreenCheckFn,
  siteThumbnailFn,
  sitePreviewSnapshotFn,
  buildStaticPublishFn,
  siteActivateFn,
  idleCoachScanFn,
  dispatchDecisionFn,
  dispatchAutoCronFn,
  dispatchChannelActionFn,
  reconcileChannelActionExecFn,
  reconcileDecisionEmailSendFn,
  opsAlertOutboxDrainFn,
  teamReportPingsDrainFn,
  distillSlackEventFn,
  slackMessageLifecycleFn,
  slackTriageFn,
  slackTriageReplyFn,
  slackOutboxDrainerFn,
  slackOutboxPurgeFn,
  emailTriageFn,
  emailTriageReplyFn,
  teamsTriageReplyFn,
  telegramTriageReplyFn,
  discordTriageReplyFn,
  setupDraftRefundOnCompleteFn,
  setupDraftRefundOnFailFn,
  cgoGoalOwnerFn,
  founderOrderAdviceFn,
  chatCardDeliverFn,
  cgoNoteEmailFn,
  cgoAnswersWakeFn,
  cgoDailyCheckFn,
  onboardingEmailSweepFn,
  adBudgetReconcileFn,
  adBudgetReconnectReadFn,
  liveStuntSnapshotFn,
  liveStuntDraftFn,
  cgoBudgetReviewFn,
  adSpendControllerFn,
  knowledgeImportReadFn,
  whatsappTriageReplyFn,
  imessageTriageReplyFn,
  distillChatTurnFn,
  ruleSuggestChatFn,
  teamNoteJudgeFn,
  distillAgentRunFn,
  previewUpgradeRerunFn,
  persistRunTraceFn,
  agentTraceGcFn,
  teamReportsGcFn,
  customDomainVerifySweepFn,
  loopClosureAuditFn,
  distillBackfillFn,
  distillRoutineCandidateFn,
  distillSkillCandidateFn,
  dreamCycleFn,
  dreamCycleTenantFn,
  pingFn,
  bulkEmailFanoutFn,
  emailSendOutcomeTellFn,
  emailResultsCheckFn,
  xOrganicTrialsFn,
  emailPlanTickFn,
  memoryEnrichmentFn,
  autoProvisionTenantFn,
  bootstrapAnchorsFn,
  cleanupStaleOnboardingDraftsFn,
  onboardingScanFn,
  onboardingWebsiteMemoryFn,
  pollTrackerCommentsFn,
  agentLearnWeeklyFn,
  agentCsatRollupFn,
  bookingRollupRefreshFn,
  outcomeRollupSweepFn,
  outcomeRollupRefreshFn,
  teamDiscoverFn,
  chatImageStaleSweepFn,
  hostingIdleReaperFn,
  siteIdleSweepFn,
  patternsNightlyScannerFn,
  patternsNightlyHandlerFn,
  growthOrchestratorDailyFn,
  channelSweepFn,
  vendorUsageReconcileFn,
  perfmktPulseFn,
  memoryRecallCanaryFn,
  memoryRecallEvalFn,
  runFailureRateCanaryFn,
  scheduledDeliverySloFn,
  slackDeliveryFailureCanaryFn,
  slackDeliveryCanaryFn,
  regressionMintFn,
  sitePrSettleFn,
  selfHealScanFn,
  planCriticFn,
  workQueueDrainerFn,
  memorySignalBackfillFn,
  memorySignalGcFn,
  memoryStaleNoteArchiveFn,
  memoryForgetPurgeFn,
  memoryWriteMaintenanceFn,
  memoryWriteDailyFn,
  memoryCleanupRequestedFn,
  memoryCleanupTenantFn,
  memoryOutcomeStampFn,
  memoryGapDistillFn,
  batchFanoutWorktreeReaperFn,
  batchFanoutRefundReconcilerFn,
  handoffBatchJoinFn,
  askChildCompletedFn,
  askDeadlineFn,
  askSweepFn,
  customAgentHandoffJoinFn,
  voiceSidecarHealthPingFn,
  voiceCallbackEventsCleanupFn,
  praxisDoctorCronFn,
  slackAutoJoinFn,
  slackWelcomeFn,
  slackEnsureDigestChannelFn,
  slackChannelIntroFn,
  slackTailoredOnboardingStartFn,
  slackTailoredOnboardingCompleteFn,
  slackChannelSummarizeSchedulerFn,
  slackChannelSummarizeTenantFn,
  lowConfDispatchSweepFn,
  operatorFollowthroughSweepFn,
  strategistReviewSweepFn,
  slackMessageIndexPruneFn,
  memoryNoteEnrichFn,
  slackW2PurgeFn,
  slackChannelMembersRefreshSchedulerFn,
  slackChannelMembersRefreshTenantFn,
  provisioningReconcileFn,
  provisioningDeployPollFn,
  approvalSlackNotifyFn,
  approvalStrandProbeFn,
  slackBatchDecideFn,
  slackNlRouteFn,
  goalReconcileFn,
  metricSweepFn,
  engineerPostdeployVerifyFn,
  engineerPrCiReadbackFn,
  autopilotWaiverExpireFn,
  refineSuggestionScanFn,
  infraReaperFn,
  siteReaperFn,
  siteShardsMaintenanceFn,
  siteFunctionsSchedulerFn,
  siteFunctionsRunBatchFn,
  siteFunctionsSweeperFn,
  siteFormNotifyFn,
  siteShardsMetricsFn,
  siteShardProvisionFn,
  siteShardsSchemaRolloutFn,
  siteReconcileFn,
  previewReaperFn,
  launchVideoPublicReaperFn,
  startCardFn,
  startCardQueueDrainFn,
  startCardTenantSettleFn,
  startCardTenantSettleSweepFn,
  reapStaleBrowserSessionsFn,
  outboundSequenceTickFn,
  reconcileActionOutcomesFn,
  repoProfileBuildFn,
  operatorDbDiscoverFn,
  bookingMappingDetectFn,
  bookingMappingBackfillFn,
  repoConventionsDistillFn,
  scoreRunsFn,
  negExistenceGroundFn,
  qaWeeklyExecuteFn,
  competitorIntelWeeklyFn,
  materialNewsScanFn,
  materialNewsDigestFn,
  mentionAlertSendFn,
  engineerAuditWeeklyFn,
  nightlySelfImproveFn,
  decisionsAutoExpireFn,
  readinessScanFn,
  brainJudgeScanFn,
  goalProposerScanFn,
  fdeFoldScanFn,
  shadowCanaryCronFn,
  autopilotRemitSweepFn,
  fundraisingRunAngelRoundFn,
  socialPublishFn,
  tiktokPublishFn,
  renderLaunchVideoFn,
  generateVideoFn,
  generateChannelVideoFn,
  companyBrainHeartbeatFn,
  marketplaceRollupFn,
  marketplaceRollupRequestedFn,
  deployTruthPollFn,
  geoPromptSweepFn,
  redditSweepFn,
  redditSweepCronFn,
];
