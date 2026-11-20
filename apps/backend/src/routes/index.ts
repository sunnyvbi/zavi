import { signupLocation } from "./auth/signup-location";
import { disconnectActorMiddleware } from "@/services/connectors/core/connector-events";
import { chatgptBoundRoute } from "./ads/chatgpt-bound-route";
import { adsBoundCampaigns, adsCampaignLaunchSummary, adsCampaignLaunch, adsCampaignPause } from "./ads/campaigns";
import { adsAccounts, adsAvailableAccounts, adsConnectAccount, adsSelectAccount, adsDisableAccount, adsEnableAccount, adsImportCampaign, adsWalletConsent, adsWalletReservations } from "./ads/accounts";
import { adsWallet, adsFund, adsDisableRefill, adsCards, adsCardSetup, adsCardSetupComplete, adsCardSelect, adsCardPay, adsOrderStatus } from "./ads/wallet";
import {
  getInviteCard,
  getInviteConversations,
  getInviteMessages,
  postInviteMessageRoute,
} from "./creators/invite-messages";
import { chatgptWallet, chatgptFund, chatgptDisableRefill, chatgptCards, chatgptCardSetup, chatgptCardSetupComplete, chatgptCardSelect, chatgptCardPay, chatgptOrderStatus } from "./channels/chatgpt-ads-wallet";
import { idempotencyFor, mountIdempotency } from "@/services/http/idempotency";
import { linkedinReviewAction, linkedinPrepareAction, linkedinCreateAudiences, linkedinSearchTargeting, linkedinSearchLocations, linkedinPreviewPost, linkedinListPosts, linkedinProposePause, linkedinProposeResume, linkedinFileCampaignDraft, linkedinProposeArchive, linkedinProposeGroupStatus, linkedinProposeAdStatus, linkedinProposeCampaignDuplicate, linkedinProposeGroupDuplicate } from "./channels/linkedin-ads";
import { chatgptCampaignResources, chatgptReviewAction, chatgptPrepareAction, chatgptCreateAdImage, chatgptLaunchSummary, chatgptLaunch, chatgptLocations, chatgptReport, chatgptResources, chatgptReadCampaign, chatgptEditGroup, chatgptSafety, chatgptCreateGroup, chatgptSaveCreative, chatgptUpdateGroup, chatgptEntities, chatgptUpdateCampaign, chatgptCreateCampaign, chatgptUpdateAd } from "./channels/chatgpt-ads";

import express, { type Express, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import rateLimit from "express-rate-limit";
import { isExtensionChatTurn } from "@/services/agents/extension-spend-guard";

import { takesScorecard } from "./takes/scorecard";
import {
  competitorIntelGet,
  postCompetitorBrands,
  postCompetitorRecDecision,
  postCompetitorRecEvent,
  postCompetitorFirstScan,
} from "./competitor-intel";
import { onboardingChat } from "./onboarding/chat";
import { onboardingBrainstorm } from "./onboarding/brainstorm";
import { onboardingGenerateMemory } from "./onboarding/generate-memory";
import { onboardingActivate } from "./onboarding/activate";
import { postOnboardingBuildStart } from "./onboarding/build-start";
import { getCanAddCompany } from "./onboarding/can-add-company";
import { onboardingGapAnswer } from "./onboarding/gap-answer";
import { onboardingStep } from "./onboarding/step";
import { onboardingEnrich } from "./onboarding/enrich";
import { onboardingScanCreate, onboardingScanGet } from "./onboarding/scan";
import { onboardingStartCardEmail } from "./onboarding/start-card-email";
import { redeemBetaSecret } from "./beta/redeem-secret";
import { humanMe } from "./humans/me";
import { postMediaUploadUrl } from "./humans/creator-signup";
import { getHumanBriefs, getHumanBriefDetail, getHumanEngagement } from "./humans/tenant";
import {
  getCreatorProfile,
  getMyIntroVideo,
  patchCreatorProfile,
  postCreatorPackage,
  postCreatorSetupDob,
  postCreatorSetupEarn,
  postCreatorSetupMake,
  postCreatorSignup,
  getCreatorHome,
} from "./creator/setup";
import { searchCreators } from "./humans/creators";
import {
  getCreatorOrder,
  getCreatorOrders,
  postCreatorOrder,
  postCreatorOrderAction,
  postCreatorOrderFulfil,
  postCreatorOrderCheckout,
  postCreatorOrderQuote,
} from "./humans/orders";
import { getBusinessNotifications, postBusinessNotificationsRead } from "./humans/notifications";
import { getOrderPublications, postOrderPublication, postPublicationVerify } from "./humans/publications";
import {
  getHumanBriefApplicants,
  getHumanBriefWorkbench,
  patchHumanBrief,
  postHumanBrief,
  postHumanBriefClose,
  postHumanBriefHire,
  postHumanBriefHireSettle,
  postHumanBriefPublish,
  postHumanBriefRepost,
} from "./humans/posted-briefs";
import {
  getOpenBrief,
  getOpenBriefQuote,
  getOpenBriefs,
  postOpenBriefApply,
} from "./humans/open-briefs";
import {
  getCreatorBriefs,
  getCreatorEarnings,
  getCreatorInbox,
  getCreatorThreads,
  getCreatorJob,
  getCreatorJobs,
  getCreatorMe,
  getCreatorReviews,
  getCreatorStorefront,
  patchCreatorPackage,
  postCreatorAccept,
  postCreatorCancellationResponse,
  postCreatorExtension,
  postCreatorMessage,
  postCreatorNotificationRead,
  postCreatorOnboardingLink,
  postCreatorPass,
  postCreatorPayoutRefresh,
  postCreatorProductReceived,
  postCreatorDispute,
  postCreatorSubmission,
  postCreatorTaxFormsLink,
  postCreatorUploadUrl,
} from "./creator";
import {
  getCreatorReputation,
  getOrderReview,
  patchOrderReview,
  postOrderReview,
} from "./humans/reviews";
import { getBusinessCreatorThreads, getCreatorCard, getCreatorIntroVideo } from "./humans/creator-hub";
import {
  getCreatorLibrary,
  getCreatorLibraryAsset,
  getCreatorLibraryDownload,
  getCreatorLibraryMetaEligibility,
  postCreatorLibraryMetaAd,
} from "./creators/library";
import {
  getCreatorLibraryYoutubeEligibility,
  postCreatorLibraryYoutubeAd,
  postCreatorLibraryYoutubeVideo,
} from "./creators/library-youtube";
import { agentsList } from "./agents/list";
import {
  customAgentsCreate,
  customAgentsGet,
  customAgentsList,
  customAgentsNoteDelete,
  customAgentsNotes,
  customAgentsPatch,
  customAgentsReceipts,
  customAgentsRuns,
  customAgentsSetStatus,
  customAgentsUnarchive,
  customAgentsSchedulePreview,
  customAgentsTest,
} from "./agents/custom-agents";
import { billingCheckout } from "./billing/checkout";
import { billingPortal } from "./billing/portal";
import { billingSubscription, billingChangePlan, billingCancel, billingResume } from "./billing/subscription";
import { billingUsage } from "./billing/usage";
import { billingUsageBreakdown } from "./billing/usage-breakdown";
import { billingCredits } from "./billing/credits";
import { billingRunCredits } from "./billing/run-credits";
import { billingInvoices } from "./billing/invoices";
import { billingTopup } from "./billing/topup";
import { billingIapIntent } from "./billing/iap-intent";
import { startupOfferCheckout } from "./billing/startup-offer";
import { agentVisibilityList } from "./agents/visibility";
import { agentRun } from "./agents/run";
import { agentRunStatus } from "./agents/run-status";
import { agentRunTrace } from "./agents/run-trace";
import { agentRunCancel } from "./agents/run-cancel";
import { agentRunBrainAnchors } from "./agents/brain-anchors";
import {
  agentScheduleGet,
  agentSchedulePut,
  agentScheduleDelete,
} from "./agents/schedule";
import { agentDraft } from "./agents/draft";
import { agentChatSend } from "./agents/chat-send";
import { agentClarifySubmit } from "./agents/clarify-submit";
import { connectorRequestContinue } from "./chat/connector-request-continue";
import { buildConfirmStart } from "./chat/build-confirm-start";
import { agentChatHistory } from "./agents/chat-history";
import { agentRunProgress } from "./agents/run-progress";
import { threadHandoffProgress } from "./agents/thread-handoff-progress";
import { agentListThreads } from "./agents/list-threads";
import { agentListThreadsFeed } from "./agents/list-threads-feed";
import { agentDashboard } from "./agents/dashboard";
import { agentCampaignThumbnails } from "./agents/campaign-thumbnails";
import { withMetaCaller } from "@/services/tools/meta-ads/_cooldown";
import { agentCampaignDetail } from "./agents/campaign-detail";
import { disputeDetail, disputeHistory } from "./agents/dispute-detail";
import { getBookingConfig, upsertBookingConfig } from "./agents/booking-config";
import {
  marketplaceIntelligenceDashboard,
  marketplaceIntelligenceSetup,
} from "./agents/marketplace-intelligence-dashboard";
import { growthConstraintDiagnosis } from "./agents/constraint-diagnosis";
import { proPageGate } from "./agents/pro-page-gate";
import { fundraisingSetOutreachState } from "./agents/fundraising-outreach-state";
import { fundraisingSetInvestorEmail } from "./agents/fundraising-investor-email";
import { fundraisingSetReviewState } from "./agents/fundraising-review-state";
import { fundraisingSetReviewDone } from "./agents/fundraising-review-done";
import { fundraisingMarkOutreachSent } from "./agents/fundraising-outreach-sent";
import { fundraisingMarkOutreachReplied } from "./agents/fundraising-outreach-replied";
import {
  fundraisingSetRoundConfig,
  fundraisingSetRoundStage,
  fundraisingRunAngelRound,
  fundraisingSuggestRoundConfig,
} from "./agents/fundraising-round-config";
import { fundraisingSetRaisePhase } from "./agents/fundraising-raise-phase";
import {
  fundraisingCreateRaiseIntro,
  fundraisingMarkIntroSent,
  fundraisingCreateRaiseMeeting,
  fundraisingSetMeetingPrep,
  fundraisingDebriefRaiseMeeting,
} from "./agents/fundraising-raise-actions";
import { qaSetTestCaseTested } from "./agents/dashboards/qa-tested";
import { qaRunTests } from "./agents/dashboards/qa-run";
import { agentProposals } from "./agents/proposals";
import {
  performanceMarketerBudgetEdit,
  performanceMarketerPause,
  performanceMarketerCampaignStatus,
  performanceMarketerDecisionStatus,
} from "./agents/budget-edit";
import { agentOutcomes } from "./agents/outcomes";
import { agentDeleteThread } from "./agents/delete-thread";
import { agentRenameThread } from "./agents/rename-thread";
import { agentFork } from "./agents/fork";
import { agentSave, agentEditSchema } from "./agents/save";
import { agentAiAssist } from "./agents/ai-assist";
import { agentSetupPost } from "./agents/setup";
import { slackStart, slackCallback } from "./connectors/slack";
import { slackScopeStatus } from "./connectors/slack-scope-status";
import { setSlackWorkspaceMetaHandler } from "./connectors/slack-workspace-meta";
import { teamsStatus, teamsBind, teamsDisconnect } from "./connectors/teams";
import { telegramStatus, telegramLink, telegramDisconnect } from "./connectors/telegram";
import { whatsappStatus, whatsappLink, whatsappConfirm, whatsappDisconnect } from "./connectors/whatsapp";
import { imessageStatus, imessageLinkRoute, imessageConfirm, imessageDisconnect } from "./connectors/imessage";
import { discordStatus, discordLink, discordDisconnect } from "./connectors/discord";
import {
  githubStart,
  githubCallback,
  githubInstallUrl,
  githubDisconnect,
} from "./connectors/github";
import {
  setDefaultRepoHandler,
} from "./connectors/github-default-repo";
import {
  listRepoBranchesHandler,
  setRepoBranchHandler,
} from "./connectors/github-repo-branch";
import {
  setSelectedReposHandler,
  clearSelectedReposHandler,
} from "./connectors/github-selected-repos";
import {
  getProductUrlHandler,
  setProductUrlHandler,
  clearProductUrlHandler,
} from "./connectors/tenant-product-url";
import {
  getCompanyFactsHandler,
  getCompanyFactSuggestionsHandler,
  setCompanyFactsHandler,
  companyCompetitorSuggestionsHandler,
  companyDescriptionDraftHandler,
  dismissCompanyDescriptionDraftHandler,
  brandVoiceDraftHandler,
  dismissBrandVoiceDraftHandler,
} from "./connectors/tenant-company-facts";
import { metaAdsStart, metaAdsCallback, metaAdsFinalize, metaAdsDisconnect } from "./connectors/meta-ads";
import { tiktokStart, tiktokCallback, tiktokDisconnect } from "./connectors/tiktok";
import { googleAdsStart, googleAdsCallback, googleAdsFinalize } from "./connectors/google-ads";
import { googleAnalyticsStart, googleAnalyticsCallback, googleAnalyticsFinalize } from "./connectors/google-analytics";
import { googleSearchConsoleStart, googleSearchConsoleCallback, googleSearchConsoleFinalize } from "./connectors/google-search-console";
import { searchConsoleSummary } from "./seo/search-console";
import {
  geoCrawlerBotGet,
  geoCrawlerHitsGet,
  geoCrawlerSetupGet,
  geoEvidenceGet,
  geoIngestTokenRevoke,
  geoIngestTokenRotate,
  geoMetricsGet,
  geoPromptAccept,
  geoPromptArchive,
  geoPromptCreate,
  geoPromptStarter,
  geoPromptSuggest,
  geoPromptsGet,
  geoRivalsPut,
  geoRivalAdd,
  geoSweepCreate,
  geoSweepGet,
} from "./geo";
import { posthogProjects, posthogConnect } from "./connectors/posthog";
import { emailKeyConnect, emailKeyDisconnect } from "./connectors/email-key";
import { sentryConnect } from "./connectors/sentry";
import { figmaConnect } from "./connectors/figma";
import { supabaseProjects, supabaseConnect } from "./connectors/supabase-connector";
import { googleSheetsStart, googleSheetsCallback } from "./connectors/google-sheets";
import { googleCalendarStart, googleCalendarCallback, googleCalendarFinalize } from "./connectors/google-calendar";
import { operatorDbConnect } from "./connectors/operator-db";
import { operatorDbAccessLog } from "./connectors/operator-db-access";
import { connectorPairCode, connectorRemove, connectorStatus } from "./connectors/operator-db-connector";
import {
  databaseRequestAccess,
  operatorDbDisconnect,
  operatorDbPrivacyGet,
  operatorDbPrivacyPut,
  operatorDbSetup,
  operatorDbVisibilityGet,
  operatorDbVisibilityPut,
} from "./connectors/operator-db-settings";
import { stripeConnect } from "./connectors/stripe";
import { socialConnect, socialDisconnect, socialList } from "./connectors/social";
import { socialPropose } from "./social/propose";
import { socialPostCancel, socialPostReschedule } from "./social/posts";
import { copilotkitRouter } from "./copilotkit";
import {
  higgsfieldConnect,
  higgsfieldStart,
  higgsfieldCallback,
  higgsfieldDisconnect,
} from "./connectors/higgsfield";
import {
  composioConnectStart,
  composioReturn,
  composioDisconnectRoute,
  composioToolkits,
  composioRequestApp,
} from "./connectors/composio";
import { shopifyCallback, shopifyClaim, shopifyInstall, shopifyInstallStatus } from "./connectors/shopify";
import { shopifyAppHome, shopifyAppHomeBilling, shopifyAppHomeBillingAuth, shopifyAppHomeDecide, shopifyAppHomeInstall, shopifyAppHomeInstallConfirm, shopifyAppHomeInstallConfirmation } from "./shopify/app-home";
import {
  tiktokAdAccountsGet,
  tiktokAdAccountsRefresh,
  tiktokAdAccountsSelect,
  tiktokAdAccountsManual,
} from "./connectors/tiktok-ads-accounts";
import { railFor } from "@zavi/shared";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";

const railAwareGoogleStart =
  (slug: "google_analytics" | "google_search_console", native: (req: ExpressRequest, res: ExpressResponse) => Promise<void>) =>
  (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    if (railFor(slug) !== "composio") return native(req, res);
    req.params = { ...req.params, toolkit: slug };
    return composioConnectStart(req, res);
  };
import {
  pipedreamApps,
  pipedreamConnectStart,
  pipedreamReturn,
  pipedreamDisconnect,
} from "./connectors/pipedream";
import {
  githubManifestInit,
  githubManifestCallback,
} from "./connectors/github-manifest";
import { connectorsList } from "./connectors/list";
import { getConnectorSyncStatus, getGoalHistory } from "./workspace/metric-history";
import { connectorsRecommendations } from "./connectors/recommendations";
import { connectorStart, connectorCallback, connectorComplete, connectorDisconnect } from "./connectors/connector";
import { mobileHandoff, mobileOpen, mobileReturnMiddleware } from "./connectors/mobile-return";
import { xAdsStart, xAdsCallback, xAdsDisconnect } from "./connectors/x-ads";
import { appleAdsConnect } from "./connectors/apple-ads";
import { approvalsList } from "./approvals/list";
import { approvalsOne } from "./approvals/one";
import { approvalsHistory } from "./approvals/history";
import { approvalsApprove, approvalsReject } from "./approvals/decide";
import { approvalsApproveMove, approvalsFindMoney, approvalsMoveFit, approvalsRejectMove } from "./approvals/move";
import { approvalsArchive, approvalsSnooze, approvalsUnsnooze } from "./approvals/close";
import { channelsList } from "./channels/list";
import { siteRescan } from "./channels/site-rescan";
import { channelRun } from "./channels/run";
import { channelPreviewOnOpen } from "./channels/preview-on-open";
import { startTopAction, topActionContext, topActionRun } from "./channels/top-actions";
import { tiktokCampaignCreate, tiktokCampaignDetail, tiktokCampaignEdit, tiktokCampaignOptions, tiktokCampaignVideo, tiktokCampaignVideoLibrary } from "./channels/tiktok-campaigns";
import { metaBoostOptions, metaBoostCreate } from "./channels/meta-boost";
import { paidAnalyticsRead } from "./channels/paid-analytics";
import { tiktokAnalyticsRead } from "./channels/tiktok-analytics";
import { xAnalyticsRead } from "./channels/x-analytics";
import { redditAnalyticsRead } from "./channels/reddit-analytics";
import { linkedinAdAnalyticsRead } from "./channels/linkedin-analytics";
import { metaEditorCreate, metaEditorCreateAd, metaEditorCreateAdSet, metaEditorLocations, metaEditorRead, metaEditorSave } from "./channels/meta-ads-editor";
import { googleEditorCreate, googleEditorCreateAd, googleEditorCreateAdGroup, googleEditorLocations, googleEditorRead, googleEditorSave, youtubeEditorCreate, youtubeEditorLocations, youtubeEditorRead, youtubeEditorSave } from "./channels/google-ads-editor";
import { tiktokSendToDrafts } from "./channels/tiktok-drafts";
import { startersRead, startersStart } from "./channels/starters";
import { videoStudioGallery, videoStudioPrompt, videoStudioRead, videoStudioRender, videoStudioScript, videoStudioSend, videoStudioThreads } from "./video-studio";
import { videoStudioPost, videoStudioPostTargets } from "./video-studio/post";
import { channelCheckDone } from "./channels/checks";
import { postDraftPhotoUpload, postDraftPhotoImport, postDraftVideoUrl } from "./channels/post-draft-photo";
import { channelPostDraftRead, channelPostDraftSave } from "./channels/post-draft";
import { channelReviseDraft } from "./channels/revise-draft";
import { channelBlankSuggestions } from "./channels/blank-suggestions";
import {
  redditCommunityCreate,
  redditCommunityUpdate,
  redditCompetitorCreate,
  redditCompetitorUpdate,
  redditKeywordCreate,
  redditKeywordUpdate,
  redditWorkspaceDelete,
  redditWorkspaceGet,
  redditWorkspaceSuggest,
} from "./reddit/workspace";
import { redditInsightsGet, redditSweepPost } from "./reddit/insights";
import { redditWorkspaceV2Gate, redditWriteRoleGate } from "./reddit/gate";
import { redditThreadDraftPost, redditThreadUpdate } from "./reddit/threads";
import { approvalsRedoRequest } from "./approvals/redo";
import { approvalsApproveBatch, approvalsRejectBatch } from "./approvals/decide-batch";
import { approvalsRevisionRequest } from "./approvals/revision";
import { approvalsRevisionTranscript } from "./approvals/revision-transcript";
import { autonomyList, autonomySet } from "./approvals/autonomy";
import { approvalsFinalizeEvidence } from "./approvals/finalize-evidence";
import { approvalsAdsAutopilot } from "./approvals/ads-autopilot";
import { postHumanApplication } from "./humans/applications";
import {
  getHumanApplicationMessages,
  postHumanApplicationMessage,
} from "./humans/messages";
import {
  getCreatorThreadMessages,
  getCreatorThreadOffers,
  openCreatorThread,
  postCreatorThreadMessageRoute,
} from "./creators/threads";
import {
  acceptCreatorOfferRoute,
  declineCreatorOfferRoute,
  getCreatorOffer,
  postStorefrontOffer,
  postCreatorOfferCheckout,
  postThreadOffer,
  withdrawCreatorOfferRoute,
} from "./creators/offers";
import { artifactsList } from "./artifacts/list";
import { artifactsApply, artifactsReject } from "./artifacts/decide";
import { a2aAgentCards } from "./a2a/agent-cards";
import { a2aDispatch } from "./a2a/dispatch";
import {
  memoryNotesList,
  memoryNoteGet,
  memoryNoteUpsert,
  memoryNoteDelete,
  memorySearch,
  memoryConflictsList,
  memoryNoteUnsupersede,
  memoryDreamCycleStatus,
} from "./memory/notes";
import {
  memoryConflictKeep,
  memoryForgetUndo,
  memoryNoteForget,
  memoryNoteUndoUpdate,
  memoryOpenConflicts,
  memoryRecentWrites,
  memoryWriteRestore,
  memoryWritesGet,
} from "./memory/writes";
import {
  deleteExtensionConsent,
  getExtensionConsent,
  postExtensionConsent,
} from "./extension/consent";
import { extensionScreenshotChain } from "./extension/screenshot";
import {
  deleteExtensionSession,
  getExtensionNextOp,
  postExtensionOpResult,
  postExtensionSession,
  postExtensionSessionHeartbeat,
} from "./extension/browser-ops";
import { extensionConnectStart } from "./extension/connect-start";
import { extensionConnectRedeem } from "./extension/connect-redeem";
import { getPersonalization, putPersonalization } from "./personalization/settings";
import {
  agentFeedbackRule,
  rulesActivate,
  rulesAdd,
  rulesDelete,
  rulesDeleteAll,
  rulesDismiss,
  rulesEdit,
  rulesList,
  rulesSettings,
  rulesAdGuardGet,
  rulesAdGuardPut,
} from "./rules";
import { deleteBrandKit, getBrandKit, putBrandKit } from "./workspace/brand-kit";
import { getPersonalizationSummary } from "./personalization/summary";
import {
  archivePersonalizationDocument,
  deletePersonalizationDocument,
  listPersonalizationDocuments,
  personalizationDocumentUrl,
  personalizationReplaceChain,
  personalizationUploadChain,
  restorePersonalizationDocument,
} from "./personalization/documents";
import { deleteImport, deleteImportedFact, listImports, readImport } from "./knowledge/import";
import { memoryRegenerateAnchor } from "./memory/regenerate-anchor";
import { memorySkillDraft } from "./memory/skill-draft";
import { routinesList, routineAuthor, routineApprove } from "./routines";
import { authBootstrapStatus } from "./auth/bootstrap-status";
import { authEmailSendOtp } from "./auth/send-otp";
import { authEmailSendReset } from "./auth/send-reset";
import { authPatMint, authPatList, authPatRevoke } from "./auth/pat";
import { accountDelete, accountDeleteLimiter } from "./account";
import { mcpPost, mcpGet } from "./mcp";
import { oauthConsentInfo, oauthConsentApprove, oauthConsentDeny } from "./oauth/consent";
import { submitSnapshot } from "./snapshots/submit";
import { listSnapshots } from "./snapshots/list";
import { feedbackMine, feedbackSubmit } from "./feedback/submit";
import { feedbackProductMine, feedbackProductSeen, feedbackProductSubmit } from "./feedback/product";
import {
  teamNoteDismiss,
  teamNoteOpened,
  teamNotePrefsGet,
  teamNotePrefsPut,
  teamNoteSend,
  teamNoteShown,
} from "./team-notes";
import { eventsIngest } from "./events/ingest";
import {
  chatImageUpload,
  chatImageUploadMiddleware,
} from "./chat/upload-image";
import { chatDocUploadChain, chatVideoUploadChain } from "./chat/upload-doc";
import { attachRunArtifact } from "./chat/attach-artifact";
import { chatImageUrl } from "./chat/image-url";
import { runArtifactUrl } from "./run-artifacts/file-url";
import { runArtifactThumbnails } from "./run-artifacts/thumbnails";
import { listRunArtifacts } from "./run-artifacts/list";
import {
  createRunArtifact,
  createRunArtifactUpload,
} from "./run-artifacts/create";
import {
  deleteRunArtifact,
  getRunArtifact,
  updateRunArtifact,
} from "./run-artifacts/detail";
import { homeSummary } from "./home/summary";
import { postHomeGoal } from "./home/goals";
import { getWhatMoved, postAnomalyMute } from "./analytics/what-moved";
import { postOnboardingEmailVisit } from "./onboarding-emails/visit";
import { publicLiveFeed } from "./public/live-feed";
import { gatekeeperCheck } from "./gatekeeper/check";
import { publicPricing } from "./public/pricing";
import { publicBuildFraming } from "./public/build-framing";
import { publicSiteTemplatesRoute } from "./public/site-templates";
import { publicLiveStats } from "./public/live-stats";
import { siteWake } from "./public/site-wake";
import { SITE_WAKE_PATH } from "@/services/sites/contract";
import { getLiveUpcarReview, postLiveUpcarReview, publicLivePill, publicLiveUpcar } from "./public/live-upcar";
import { postUpcarHourlyCounts } from "./ingest/upcar-counts";
import { launchVideoPublicGenerate } from "./public/launch-video-generate";
import { launchVideoPublicConfig } from "./public/launch-video-config";
import { launchVideoPublicPrefill } from "./public/launch-video-prefill";
import { launchVideoPublicChat } from "@/routes/public/launch-video-chat";
import { launchVideoPublicStatus } from "./public/launch-video-status";
import { launchVideoPublicSendMagicLink } from "./public/launch-video-magic-link";
import { launchVideoClaim } from "./public/launch-video-claim";
import { getCreatorAffiliate } from "./creator/affiliate";
import { postAffiliateClick } from "./public/affiliate";
import {
  startCardConfig,
  startCardCreate,
  startCardGet,
  startCardQueue,
  startCardQueueConfirm,
  startCardReport,
  startCardReportConfirm,
  startCardReportConfirmPage,
} from "./public/start-card";
import { leaderboardList, leaderboardRank } from "./public/leaderboard";
import { seedNoticeUnsubscribe, seedNoticeUnsubscribePage } from "./public/seed-notice";
import { workspaceBootstrap } from "./workspace/bootstrap";
import { workspaceTree } from "./workspace/tree";
import {
  workspaceTabsSessionGet,
  workspaceTabsSessionPost,
} from "./workspace/tabs-session";
import { workspaceStatusCounters } from "./workspace/status-counters";
import { workspaceActivation } from "./workspace/activation";
import { onboardingMemoryRetry } from "./workspace/onboarding-memory-retry";
import { workspaceInboxAddresses } from "./workspace/inbox-addresses";
import { workspaceAgentSeen } from "./workspace/agent-seen";
import { workspaceOpened } from "./workspace/opened";
import { postBuildWatch } from "./workspace/build-watch";
import {
  workspaceAgentPinsGet,
  workspaceAgentPinsPut,
} from "./workspace/agent-pins";
import { workspaceAgentUnread } from "./workspace/agent-unread";
import { workspaceThreadSeen } from "./workspace/thread-seen";
import { workspaceListThreads } from "./workspace/threads";
import { workspaceListChannelThreads } from "./workspace/channel-threads";
import { workspaceMorningBrief } from "./workspace/morning-brief";
import { workspaceGrowthStrategy } from "./workspace/growth-strategy";
import { decisionCheck } from "./workspace/decision-check";
import { workspaceGrowthStrategyDraft } from "./workspace/growth-strategy-draft";
import {
  workspaceGrowthStrategyAccept,
  workspaceGrowthStrategyApply,
} from "./workspace/growth-strategy-accept";
import { postGrowthChannelAutorun } from "./workspace/growth-channel-autorun";
import { getAdBudget, getAdBudgetChannels, getAdBudgetLedger, postAdBudget, patchAdBudget, postAdBudgetStop, postAdBudgetHumanAction, postAdChangeUndo } from "./workspace/ad-budget";
import { getGrowthControls, putGrowthControls, postGrowthExperiment, getBusinessControlsProposal } from "./workspace/growth-controls";
import { putChannelMonthlyBudget } from "./channels/monthly-budget";
import {
  channelActionApprove,
  channelActionPublishOn,
  channelActionRedo,
  channelActionSet,
  channelActionSteps,
  channelActionsList,
  channelVideoCardRead,
  channelHistoryCardRead,
  channelMetricsList,
} from "./channels/actions";
import { channelActionsReleaseHeld } from "./channels/release-held";
import { channelSettingsGet, channelSettingsPut } from "./channels/settings";
import { channelHistoryGet } from "./channels/history";
import { channelAdReview, channelAdRevise, channelAdPreview } from "./channels/ad-review";
import { pinterestBoardCreate, pinterestBoardSearch, pinterestReadinessGet } from "./channels/pinterest-readiness";
import { adLocationsSave, adLocationsSearch, adLocationsStatus, adLocationsSuggestions, tiktokAdLocationsSearch, xAdLocationsSearch } from "./channels/ad-locations";
import { postGrowthChannelPlan } from "./workspace/growth-channel-plan";
import { getDoneForYou, postDoneForYou } from "./workspace/growth-done-for-you";
import { getGrowthPlan, postAcceptSuggestedGoal, postKeepPlanConflict } from "./workspace/growth-plan";
import {
  getGrowthDoneWeek,
  getGrowthOpenCards,
  getGrowthTests,
  postGrowthCardCopied,
  postConstraintAgree,
  postConstraintFounder,
  postConstraintSwitch,
} from "./workspace/growth-j6";
import { getGrowthAdHolds, getGrowthQuestions, getGrowthScheduler, getGrowthYouAsked, postGrowthQuestionAnswer, putGrowthAutopilot, postAutopilotMistake, postChannelSeen, postUndoCgoChange } from "./workspace/head-of-growth";
import { getNextTiles, postNextTilesMark } from "./workspace/next-tiles";
import { getSetup, postSetupDraft, postSetupProgress } from "./workspace/setup";
import {
  getGrowthInterview,
  postGrowthInterviewAnswer,
  postGrowthInterviewSkip,
  postGrowthStrategyReset,
} from "./workspace/growth-interview";
import { getGrowthIntakeLearned, postGrowthIntakeResearch } from "./workspace/growth-intake-research";
import {
  workspaceNotetakerSettingsGet,
  workspaceNotetakerSettingsPut,
  workspaceNotetakerRecapPut,
  workspaceSlackChannelsGet,
} from "./workspace/notetaker-settings";
import {
  workspaceNotetakerJoin,
  workspaceNotetakerMeetings,
  workspaceNotetakerAtoms,
  workspaceNotetakerNotes,
} from "./workspace/notetaker-join";
import {
  workspaceMemoryCardsList,
  workspaceMemoryCardApprove,
  workspaceMemoryCardIgnore,
} from "./workspace/memory-cards";
import {
  getWorkspaceExportGithubDest,
  getWorkspaceExportGithubStatus,
  postWorkspaceExportGithub,
} from "./workspace/export-github";
import { getWorkspaceAppCodeFile, getWorkspaceAppCodeTree, getWorkspaceAppCodeZip } from "./workspace/app-code";
import { postSiteDuplicate } from "./workspace/site-duplicate";
import {
  deleteWorkspaceFileCollection,
  deleteWorkspaceFileCollectionFile,
  deleteWorkspaceFileRoute,
  getPublicWorkspaceFile,
  getWorkspaceFiles,
  patchWorkspaceFileCollection,
  postWorkspaceFileCollection,
  postWorkspaceFileCollectionFiles,
  workspaceFilesUploadChain,
} from "./workspace/workspace-files";
import { getAutopilot, getAutopilotRuns, getAutopilotRunDetail, getAutopilotBuildStatus, getAutopilotBuildSessions, getAutopilotRefines, postAutopilotSettings, postAutopilotBuildProduct, postAutopilotRefineProduct, postAutopilotRefineUndo, postAutopilotRestoreCheckpoint, postAutopilotBuildAdminLink, postAutopilotVersionPreview, getAutopilotVersionPreview, getAutopilotDeployStatus, getAutopilotRestoreStatus, postAutopilotUndoNode, postAutopilotCancelRun, postAutopilotContinueRun, postAutopilotWaiver, deleteAutopilotWaiver, getAutopilotWaivers, getAutopilotChips, postAutopilotPlan, postAutopilotClarifyQuestions, getAutopilotGoals, postAutopilotGoals, patchAutopilotGoal, deleteAutopilotGoal, getAutopilotGoalCurrentValue } from "./workspace/autopilot";
import { getLiveEditState, postPublishDraft, postDiscardDraft, postWakeLiveEditPreview } from "./workspace/live-edit";
import { postRestartBuildPreview } from "./workspace/build-preview-restart";
import { getSiteDesign, postSiteDesignDirection } from "./workspace/site-design";
import { postRebuildOldSite } from "./workspace/old-site-rebuild";
import { postSitePublish } from "./workspace/site-publish";
import { postSiteSearchRelease } from "./workspace/site-search-release";
import { postSiteRename } from "./workspace/site-rename";
import { postWebsiteChat } from "./workspace/website-chat";
import { getMaterialNewsPref, postMaterialNewsPref } from "./workspace/material-news-pref";
import { getNotificationPrefs, patchNotificationPrefs } from "./workspace/notification-prefs";
import {
  getEngineerPreviewStatus,
  engineerPreviewProxy,
  restartEngineerPreviewRoute,
} from "./workspace/engineer-preview";
import {
  acknowledgeEngineerHtmlPreviewDisplayed,
  getEngineerHtmlPreviewArtifact,
} from "./workspace/engineer-html-preview-artifact";
import { openEngineerSitePreview, closeEngineerSitePreview } from "./workspace/engineer-site-preview";
import {
  getWebsiteOverviewHandler,
  setWebsiteSettingsHandler,
} from "./workspace/website-overview";
import {
  getSiteFunctionsHandler,
  getSiteFunctionRunsHandler,
  putSiteSecretHandler,
  deleteSiteSecretHandler,
  setSiteScheduleHandler,
} from "./workspace/website-site-functions";
import { getSiteAnalyticsHandler } from "./workspace/website-site-analytics";
import {
  deleteEmailContact,
  deleteEmailList,
  getArchivedEmailLists,
  postUnarchiveEmailList,
  getBulkSendProgress,
  getEmailListContacts,
  getEmailContacts,
  getEmailLists,
  getImportTableColumns,
  getImportTables,
  importCsvChain,
  postImportDatabase,
  postListConsent,
  previewCsvChain,
} from "./workspace/email-lists";
import {
  addSendingDomainHandler,
  deleteSendingDomainHandler,
  getSendingDomainHandler,
  verifySendingDomainHandler,
} from "./workspace/sending-domain";
import {
  draftEmailTemplateHandler,
  getEmailTemplateHandler,
  putEmailTemplateHandler,
} from "./workspace/email-template";
import {
  getEmailCardCountHandler,
  getEmailCardHandler,
  patchEmailCardVariantHandler,
  postEmailCardApproveHandler,
  postEmailCardTestHandler,
  postEmailCardStopHandler,
} from "./email-cards";
import { postEmailPasteHandler } from "./email-cards/paste";
import { getEmailPauseHandler, postEmailPauseHandler } from "./workspace/email-pause";
import { getEmailResultsHandler } from "./email-results";
import { getSendgridListsHandler, getSendgridSendersHandler, getSendgridSuppressionGroupsHandler } from "./workspace/sendgrid";
import { getEmailTestListsHandler, postEmailTestListHandler } from "./workspace/email-test-lists";
import { getEmailSuppressionsHandler, postEmailSuppressionHandler } from "./workspace/email-suppressions";
import {
  getEmailLearningsHandler,
  getRemovedEmailLearningsHandler,
  postEmailLearningHandler,
  postEmailLearningsLookAgainHandler,
  postEmailLearningsSeenHandler,
} from "./workspace/email-learnings";
import {
  getEmailPlanHandler,
  postEmailPlanAngleHandler,
  postEmailPlanDraftNowHandler,
  postEmailPlanHandler,
  postEmailPlanMoveHandler,
  postEmailPlanNotSentHandler,
  postEmailPlanScheduleHandler,
  postEmailPlanSkipHandler,
  postEmailPlanWithdrawHandler,
} from "./workspace/email-plan";
import {
  getCustomDomainsHandler,
  getCustomDomainDnsProviderHandler,
  addCustomDomainHandler,
  verifyCustomDomainHandler,
  deleteCustomDomainHandler,
} from "./workspace/website-custom-domains";
import { getSiteSeoHandler, refreshSiteSeoHandler } from "./workspace/website-site-seo";
import {
  getBuiltinUrlHandler,
  setBuiltinUrlHandler,
  ensureBuiltinUrlHandler,
  deleteBuiltinUrlHandler,
} from "./workspace/website-builtin-url";
import { getAppPreviewReadinessHandler } from "./workspace/app-preview-readiness";
import {
  getWebsiteEditsHandler,
  setWebsiteEditHandler,
  publishWebsiteEditsHandler,
  unpublishWebsiteEditsHandler,
  websitePublishStatusHandler,
  websitePendingChangesHandler,
  discardWebsiteEditsHandler,
  getPublishedWebsiteEditsHandler,
} from "./workspace/website-edits";
import {
  resolveWebsiteEditHandler,
  resolveChatWebsiteEditHandler,
} from "./workspace/resolve-website-edit";
import { postApplySiteEdits } from "./workspace/site-inline-edits";
import { getSiteDesignEdit, postSiteDesignEdit } from "./workspace/site-direct-edits";
import { getSitePreviewSnapshot } from "./workspace/site-preview-snapshot";
import { listSiteComments, createSiteComment, replySiteComment, setSiteCommentStatus, siteCommentsMutationLimiter } from "./workspace/site-comments";
import { getWebsiteAppCatalogHandler } from "./workspace/website-app-catalog";
import {
  createWebsiteAppRowHandler,
  deleteWebsiteAppRowHandler,
  getWebsiteAppRowsHandler,
  updateWebsiteAppRowHandler,
} from "./workspace/website-app-rows";
import {
  createWebsiteAppInviteHandler,
  listWebsiteAppInvitesHandler,
  revokeWebsiteAppInviteHandler,
} from "./workspace/website-app-invites";
import {
  publicPrototypePage,
  getPrototypeLinkForRun,
  revokePrototypeLink,
} from "./public/prototype";
import {
  listSharedPages,
  getSharedPage,
  publishSharedPage,
  revokeSharedPage,
  shareReport,
} from "./workspace/shared-pages";
import { getPlaybooks, launchPlaybook, getPlaybookTrail } from "./playbooks";
import { authMiddleware } from "@/services/auth/middleware";
import {
  getStripePayoutAccount,
  postStripePayoutAccount,
  postStripeOnboardingLink,
  postStripeMoneyModel,
} from "./workspace/stripe-connect";
import { patchTenantSettings } from "./tenant/settings";
import { getReportingTimezone, patchReportingTimezone } from "./tenant/reporting-timezone";
import { deleteDataNoteHandler, listDataNotesHandler } from "./tenant/data-notes";
import {
  listEmailAllowlist,
  addEmailAllowlistEntry,
  removeEmailAllowlistEntry,
} from "./tenant/email-allowlist";
import { listEmailMembers, setEmailMemberEnabled } from "./tenant/email-members";
import { getPmHybridSurface } from "./tenant/pm-hybrid-surface";
import {
  commandsList,
  commandsUpsert,
  commandsDelete,
} from "./commands";
import {
  teamDiscover,
  teamMembersList,
  teamMemberDetail,
  teamMemberUpdate,
  teamMembersMerge,
} from "./team";
import { voiceSessionStart } from "./voice/session-start";
import { devicesRegister, devicesDelete } from "./devices";
import {
  getNotificationSettings,
  patchNotificationSettings,
} from "./mobile/notification-settings";
import { getMobileConfig } from "./mobile/config";
import {
  listAgentEmailRecipients,
  addAgentEmailRecipient,
  removeAgentEmailRecipient,
} from "./notifications/agent-email-recipients";
import {
  voiceInternalHealth,
  voiceInternalWarmup,
  voiceInternalSessionHydrate,
  voiceInternalAgentTurn,
  voiceInternalUtteranceUser,
  voiceInternalCostFlush,
  voiceInternalSessionEnd,
  voiceInternalError,
} from "./internal/voice/callbacks";
import { localRunsRouter } from "./internal/local-runs/handlers";
import { connectorRouter } from "./connector/handlers";
import { internalInflightRuns } from "./internal/inflight-runs";
import { internalQuiesce, internalUnquiesce } from "./internal/quiesce";

export function mountRoutes(app: Express): void {
  mountIdempotency(app);

  app.post("/mcp", mcpPost);
  app.get("/mcp", mcpGet);
  app.post("/api/auth/pat", authPatMint);
  app.get("/api/auth/pat", authPatList);
  app.delete("/api/auth/pat/:id", authPatRevoke);

  app.delete("/api/account", accountDeleteLimiter, accountDelete);

  app.post("/oauth/consent/info", oauthConsentInfo);
  app.post("/oauth/consent/approve", oauthConsentApprove);
  app.post("/oauth/consent/deny", oauthConsentDeny);

  app.post("/api/onboarding/chat", onboardingChat);
  app.post("/api/onboarding/brainstorm", onboardingBrainstorm);
  app.post("/api/onboarding/enrich", onboardingEnrich);
  app.post("/api/onboarding/scan", onboardingScanCreate);
  app.get("/api/onboarding/scan/:id", onboardingScanGet);
  app.post("/api/onboarding/generate-memory", onboardingGenerateMemory);
  app.post("/api/onboarding/activate", onboardingActivate);
  app.post("/api/onboarding/build-start", postOnboardingBuildStart);
  app.post("/api/onboarding/start-card-email", onboardingStartCardEmail);
  app.get("/api/onboarding/can-add-company", getCanAddCompany);
  app.post("/api/onboarding/gap-answer", onboardingGapAnswer);
  app.post("/api/onboarding/step", onboardingStep);
  app.post("/api/beta/redeem-secret", redeemBetaSecret);

  app.get("/api/humans/me", humanMe);

  app.post("/api/humans/media-upload-url", postMediaUploadUrl);
  app.get("/api/creator/me", getCreatorMe);
  app.post("/api/creator/signup", postCreatorSignup);
  app.get("/api/creator/home", getCreatorHome);
  app.get("/api/creator/profile", getCreatorProfile);
  app.get("/api/creator/intro-video", getMyIntroVideo);
  app.patch("/api/creator/profile", patchCreatorProfile);
  app.post("/api/creator/setup/earn", postCreatorSetupEarn);
  app.post("/api/creator/setup/dob", postCreatorSetupDob);
  app.post("/api/creator/setup/make", postCreatorSetupMake);
  app.post("/api/creator/setup/package", postCreatorPackage);
  app.post("/api/creator/packages", postCreatorPackage);
  app.get("/api/creator/inbox", getCreatorInbox);
  app.get("/api/creator/threads", getCreatorThreads);
  app.post("/api/creator/notifications/:notificationId/read", postCreatorNotificationRead);
  app.get("/api/creator/briefs", getCreatorBriefs);
  app.get("/api/creator/jobs", getCreatorJobs);
  app.get("/api/creator/jobs/:orderId", getCreatorJob);
  app.post("/api/creator/jobs/:orderId/accept", postCreatorAccept);
  app.post("/api/creator/jobs/:orderId/pass", postCreatorPass);
  app.post("/api/creator/jobs/:orderId/cancellation", postCreatorCancellationResponse);
  app.post("/api/creator/jobs/:orderId/extension", postCreatorExtension);
  app.post("/api/creator/jobs/:orderId/product-received", postCreatorProductReceived);
  app.post("/api/creator/jobs/:orderId/dispute", postCreatorDispute);
  app.post("/api/creator/jobs/:orderId/messages", postCreatorMessage);
  app.post("/api/creator/jobs/:orderId/upload-url", postCreatorUploadUrl);
  app.post("/api/creator/jobs/:orderId/submissions", postCreatorSubmission);
  app.get("/api/creator/earnings", getCreatorEarnings);
  app.get("/api/creator/reviews", getCreatorReviews);
  app.get("/api/creator/affiliate", getCreatorAffiliate);
  app.post("/api/creator/payouts/onboarding-link", postCreatorOnboardingLink);
  app.post("/api/creator/payouts/tax-forms-link", postCreatorTaxFormsLink);
  app.post("/api/creator/payouts/refresh", postCreatorPayoutRefresh);
  app.get("/api/creator/storefront", getCreatorStorefront);
  app.patch("/api/creator/storefront/packages/:packageId", patchCreatorPackage);

  app.get("/api/humans/briefs", getHumanBriefs);
  app.get("/api/humans/briefs/:briefId", getHumanBriefDetail);
  app.get("/api/humans/engagements/:engagementId", getHumanEngagement);

  app.get("/api/humans/creators/search", searchCreators);
  app.post("/api/humans/orders/quote", postCreatorOrderQuote);
  app.get("/api/humans/orders", getCreatorOrders);
  app.post("/api/humans/orders", postCreatorOrder);
  app.get("/api/humans/orders/:orderId", getCreatorOrder);
  app.post("/api/humans/orders/:orderId/fulfil", postCreatorOrderFulfil);
  app.post("/api/humans/orders/:orderId/checkout", postCreatorOrderCheckout);
  app.post("/api/humans/orders/:orderId/actions", postCreatorOrderAction);
  app.get("/api/humans/notifications", getBusinessNotifications);
  app.post("/api/humans/notifications/read", postBusinessNotificationsRead);
  app.get("/api/humans/orders/:orderId/publications", getOrderPublications);
  app.post("/api/humans/orders/:orderId/publications", postOrderPublication);
  app.post("/api/humans/publications/:id/verify", postPublicationVerify);
  app.post("/api/humans/briefs", postHumanBrief);
  app.patch("/api/humans/briefs/:briefId", patchHumanBrief);
  app.get("/api/humans/briefs/:briefId/workbench", getHumanBriefWorkbench);
  app.post("/api/humans/briefs/:briefId/publish", postHumanBriefPublish);
  app.get("/api/humans/briefs/:briefId/applicants", getHumanBriefApplicants);
  app.post("/api/humans/briefs/:briefId/hire", postHumanBriefHire);
  app.post("/api/humans/briefs/:briefId/hire/settle", postHumanBriefHireSettle);
  app.post("/api/humans/briefs/:briefId/close", postHumanBriefClose);
  app.post("/api/humans/briefs/:briefId/repost", postHumanBriefRepost);

  app.get("/api/humans/open-briefs", getOpenBriefs);
  app.get("/api/humans/open-briefs/:briefId", getOpenBrief);
  app.get("/api/humans/open-briefs/:briefId/quote", getOpenBriefQuote);
  app.post("/api/humans/open-briefs/:briefId/apply", postOpenBriefApply);
  app.get("/api/humans/orders/:orderId/review", getOrderReview);
  app.post("/api/humans/orders/:orderId/review", postOrderReview);
  app.patch("/api/humans/orders/:orderId/review", patchOrderReview);
  app.get("/api/humans/creators/:slug/reputation", getCreatorReputation);
  app.get("/api/humans/creators/:memberId/card", getCreatorCard);
  app.get("/api/humans/creators/invites/:invite_id/card", getInviteCard);
  app.get("/api/humans/creators/:memberId/intro-video", getCreatorIntroVideo);
  app.get("/api/creators/library", getCreatorLibrary);
  app.get("/api/creators/library/:asset_id", getCreatorLibraryAsset);
  app.get("/api/creators/library/:asset_id/download", getCreatorLibraryDownload);
  app.get("/api/creators/library/:asset_id/meta-eligibility", getCreatorLibraryMetaEligibility);
  app.post("/api/creators/library/:asset_id/meta-ad", postCreatorLibraryMetaAd);
  app.post("/api/creators/library/:asset_id/youtube-video", postCreatorLibraryYoutubeVideo);
  app.get("/api/creators/library/:asset_id/youtube-eligibility", getCreatorLibraryYoutubeEligibility);
  app.post("/api/creators/library/:asset_id/youtube-ad", postCreatorLibraryYoutubeAd);

  app.get("/api/agents", agentsList);
  app.post("/api/custom-agents", customAgentsCreate);
  app.get("/api/custom-agents", customAgentsList);
  app.get("/api/custom-agents/:id", customAgentsGet);
  app.patch("/api/custom-agents/:id", customAgentsPatch);
  app.post("/api/custom-agents/:id/status", customAgentsSetStatus);
  app.post("/api/custom-agents/:id/unarchive", customAgentsUnarchive);
  app.post("/api/custom-agents/schedule-preview", customAgentsSchedulePreview);
  app.post("/api/custom-agents/:id/test", customAgentsTest);
  app.get("/api/custom-agents/:id/receipts", customAgentsReceipts);
  app.get("/api/custom-agents/:id/runs", customAgentsRuns);
  app.get("/api/custom-agents/:id/notes", customAgentsNotes);
  app.delete("/api/custom-agents/:id/notes/:noteId", customAgentsNoteDelete);
  app.get("/api/competitor-intel", competitorIntelGet);
  app.post("/api/competitor-intel/custom-brands", postCompetitorBrands);
  app.post("/api/competitor-intel/rec-decisions", postCompetitorRecDecision);
  app.post("/api/competitor-intel/rec-event", postCompetitorRecEvent);
  app.post("/api/competitor-intel/first-scan", postCompetitorFirstScan);
  app.post("/api/billing/checkout", billingCheckout);
  app.post("/api/billing/startup-offer", startupOfferCheckout);
  app.post("/api/billing/portal", billingPortal);
  app.get("/api/billing/subscription", billingSubscription);
  app.post("/api/billing/change-plan", billingChangePlan);
  app.post("/api/billing/cancel", billingCancel);
  app.post("/api/billing/resume", billingResume);
  app.get("/api/billing/usage", billingUsage);
  app.get("/api/billing/usage-breakdown", billingUsageBreakdown);
  app.get("/api/billing/credits", billingCredits);
  app.get("/api/billing/run-credits", billingRunCredits);
  app.get("/api/billing/invoices", billingInvoices);
  app.post("/api/billing/topup", billingTopup);
  app.post("/api/billing/iap/intent", billingIapIntent);
  app.post("/api/agents/:slug/run", agentRun);
  app.post("/api/agents/:slug/setup", agentSetupPost);
  app.get("/api/agents/visibility", agentVisibilityList);
  app.get("/api/agents/runs/:run_id", agentRunStatus);
  app.get("/api/agents/runs/:run_id/trace", agentRunTrace);
  app.get("/api/agents/runs/:run_id/brain-anchors", agentRunBrainAnchors);
  app.post("/api/agents/runs/:run_id/cancel", agentRunCancel);
  app.post("/api/agent-runs/:id/cancel", agentRunCancel);

  app.get("/api/agents/:slug/schedule", agentScheduleGet);
  app.put("/api/agents/:slug/schedule", agentSchedulePut);
  app.delete("/api/agents/:slug/schedule", agentScheduleDelete);
  app.post("/api/agents/draft", agentDraft);

  const extensionChatLimiter = rateLimit({
    windowMs: 60_000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    skip: (req: Request) => !isExtensionChatTurn(req),
    keyGenerator: (req: Request) => "xip:" + (req.ip ?? "unknown"),
  });
  app.post("/api/agents/:slug/chat", extensionChatLimiter, agentChatSend);
  app.post("/api/agents/:slug/clarify-submit", agentClarifySubmit);
  app.get("/api/agents/:slug/chat/history", agentChatHistory);
  app.get("/api/agents/runs/:run_id/progress", agentRunProgress);
  app.get("/api/agents/threads/:thread_id/handoff-progress", threadHandoffProgress);
  app.get(
    "/api/agents/marketplace-intelligence/dashboard",
    marketplaceIntelligenceDashboard,
  );
  app.post(
    "/api/agents/marketplace-intelligence/confirm-setup",
    proPageGate("supply-demand-balancer"),
    marketplaceIntelligenceSetup,
  );
  app.get(
    "/api/agents/growth-lead/constraint-diagnosis",
    growthConstraintDiagnosis,
  );
  app.get("/api/agents/dispute-response/dispute/:id", disputeDetail);
  app.get(
    "/api/agents/dispute-response/dispute/:id/history",
    disputeHistory,
  );
  app.get("/api/agents/:slug/dashboard", (req, res) => withMetaCaller("dashboard", () => agentDashboard(req, res)));
  app.get("/api/agents/:slug/campaign-detail", agentCampaignDetail);
  app.get("/api/agents/:slug/campaign-thumbnails", agentCampaignThumbnails);
  app.use("/api/fundraising", proPageGate("fundraising"));
  app.post("/api/fundraising/outreach-state", fundraisingSetOutreachState);
  app.post("/api/fundraising/investor-email", fundraisingSetInvestorEmail);
  app.post("/api/fundraising/review-state", fundraisingSetReviewState);
  app.post("/api/fundraising/review-done", fundraisingSetReviewDone);
  app.post("/api/fundraising/outreach-sent", fundraisingMarkOutreachSent);
  app.post("/api/fundraising/outreach-replied", fundraisingMarkOutreachReplied);
  app.post("/api/fundraising/round-config", fundraisingSetRoundConfig);
  app.post(
    "/api/fundraising/round-config/suggest",
    fundraisingSuggestRoundConfig,
  );
  app.post("/api/fundraising/round-stage", fundraisingSetRoundStage);
  app.post("/api/fundraising/run-angel-round", fundraisingRunAngelRound);
  app.post("/api/fundraising/raise-phase", fundraisingSetRaisePhase);
  app.post("/api/fundraising/raise-intro", fundraisingCreateRaiseIntro);
  app.post("/api/fundraising/raise-intro/sent", fundraisingMarkIntroSent);
  app.post("/api/fundraising/raise-meeting", fundraisingCreateRaiseMeeting);
  app.post("/api/fundraising/raise-meeting/prep", fundraisingSetMeetingPrep);
  app.post(
    "/api/fundraising/raise-meeting/debrief",
    fundraisingDebriefRaiseMeeting,
  );
  app.post("/api/agents/qa/test-cases/:id/tested", qaSetTestCaseTested);
  app.post("/api/agents/qa/run-tests", qaRunTests);
  app.get("/api/agents/:slug/proposals", agentProposals);
  app.post(
    "/api/agents/performance-marketer/budget-edit",
    performanceMarketerBudgetEdit,
  );
  app.post(
    "/api/agents/performance-marketer/pause",
    performanceMarketerPause,
  );
  app.post(
    "/api/agents/performance-marketer/campaign-status",
    performanceMarketerCampaignStatus,
  );
  app.get(
    "/api/agents/performance-marketer/booking-config",
    getBookingConfig,
  );
  app.post(
    "/api/agents/performance-marketer/booking-config",
    upsertBookingConfig,
  );
  app.get(
    "/api/agents/performance-marketer/budget-edit/status/:decision_id",
    performanceMarketerDecisionStatus,
  );
  app.get("/api/agents/:slug/outcomes", agentOutcomes);
  app.get("/api/agents/:slug/threads", agentListThreads);
  app.get("/api/agents/:slug/threads-feed", agentListThreadsFeed);
  app.delete("/api/agents/:slug/threads/:threadId", agentDeleteThread);
  app.patch("/api/agents/:slug/threads/:threadId", agentRenameThread);

  app.post("/api/chat/upload-image", chatImageUploadMiddleware, chatImageUpload);
  app.post("/api/chat/upload-doc", ...chatDocUploadChain);
  app.post("/api/chat/upload-video", ...chatVideoUploadChain);
  app.post("/api/chat/attach-artifact", attachRunArtifact);
  app.get("/api/chat/image-url", chatImageUrl);
  app.post("/api/chat/connector-requests/:run_id/continue", connectorRequestContinue);
  app.post("/api/chat/build-confirm/:thread_id/start", buildConfirmStart);

  app.get("/api/run-artifacts/:id/url", runArtifactUrl);
  app.get("/api/run-artifacts", listRunArtifacts);
  app.post("/api/run-artifacts/thumbnails", runArtifactThumbnails);
  app.post("/api/run-artifacts", createRunArtifactUpload, createRunArtifact);
  app.get("/api/run-artifacts/:id", getRunArtifact);
  app.patch("/api/run-artifacts/:id", updateRunArtifact);
  app.delete("/api/run-artifacts/:id", deleteRunArtifact);

  app.post("/api/agents/:slug/fork", agentFork);
  app.get("/api/agents/:slug/edit-schema", agentEditSchema);
  app.post("/api/agents/:slug/save", agentSave);
  app.post("/api/agents/:slug/ai-assist", agentAiAssist);

  app.use("/api/connectors", mobileReturnMiddleware);
  app.post("/api/connectors/mobile/handoff", mobileHandoff);
  app.get("/api/connectors/mobile/open", mobileOpen);
  app.get("/api/connectors", connectorsList);
  app.get("/api/connectors/sync-status", getConnectorSyncStatus);
  app.get("/api/connectors/recommendations", connectorsRecommendations);
  app.get("/api/connectors/slack/start", slackStart);
  app.get("/api/connectors/slack/callback", slackCallback);
  app.get("/api/connectors/slack/scope-status", slackScopeStatus);
  app.post("/api/connectors/slack/workspace-meta", setSlackWorkspaceMetaHandler);
  app.use(disconnectActorMiddleware);
  app.get("/api/connectors/teams/status", teamsStatus);
  app.post("/api/connectors/teams/bind", teamsBind);
  app.post("/api/connectors/teams/disconnect", teamsDisconnect);
  app.get("/api/connectors/telegram/status", telegramStatus);
  app.post("/api/connectors/telegram/link", telegramLink);
  app.post("/api/connectors/telegram/disconnect", telegramDisconnect);
  app.get("/api/connectors/whatsapp/status", whatsappStatus);
  app.post("/api/connectors/whatsapp/link", whatsappLink);
  app.post("/api/connectors/whatsapp/confirm", whatsappConfirm);
  app.post("/api/connectors/whatsapp/disconnect", whatsappDisconnect);
  app.get("/api/connectors/imessage/status", imessageStatus);
  app.post("/api/connectors/imessage/link", imessageLinkRoute);
  app.post("/api/connectors/imessage/confirm", imessageConfirm);
  app.post("/api/connectors/imessage/disconnect", imessageDisconnect);
  app.get("/api/connectors/discord/status", discordStatus);
  app.post("/api/connectors/discord/link", discordLink);
  app.post("/api/connectors/discord/disconnect", discordDisconnect);
  app.get("/api/connectors/github/start", githubStart);
  app.get("/api/connectors/github/callback", githubCallback);
  app.get("/api/connectors/github/install-url", githubInstallUrl);
  app.post("/api/connectors/github/disconnect", githubDisconnect);
  app.post("/api/connectors/github/default-repo", setDefaultRepoHandler);
  app.get("/api/connectors/github/repo-branches", listRepoBranchesHandler);
  app.post("/api/connectors/github/repo-branch", setRepoBranchHandler);
  app.post("/api/connectors/github/selected-repos", setSelectedReposHandler);
  app.delete("/api/connectors/github/selected-repos", clearSelectedReposHandler);
  app.get("/api/connectors/product-url", getProductUrlHandler);
  app.post("/api/connectors/product-url", setProductUrlHandler);
  app.delete("/api/connectors/product-url", clearProductUrlHandler);
  app.get("/api/connectors/company-facts", getCompanyFactsHandler);
  app.get(
    "/api/connectors/company-facts/suggestions",
    getCompanyFactSuggestionsHandler,
  );
  app.post("/api/connectors/company-facts", setCompanyFactsHandler);
  app.post(
    "/api/connectors/company-facts/competitor-suggestions",
    companyCompetitorSuggestionsHandler,
  );
  app.post(
    "/api/connectors/company-facts/description-draft",
    companyDescriptionDraftHandler,
  );
  app.post(
    "/api/connectors/company-facts/description-draft/dismiss",
    dismissCompanyDescriptionDraftHandler,
  );
  app.post("/api/workspace/brand-voice-draft", brandVoiceDraftHandler);
  app.post("/api/workspace/brand-voice-draft/dismiss", dismissBrandVoiceDraftHandler);
  app.get("/api/connectors/meta-ads/start", metaAdsStart);
  app.get("/api/connectors/meta-ads/callback", metaAdsCallback);
  app.post("/api/connectors/meta-ads/finalize", metaAdsFinalize);
  app.post("/api/connectors/meta-ads/disconnect", metaAdsDisconnect);
  app.get("/api/connectors/tiktok/start", tiktokStart);
  app.get("/api/connectors/tiktok/callback", tiktokCallback);
  app.post("/api/connectors/tiktok/disconnect", tiktokDisconnect);
  app.get("/api/connectors/google-ads/start", googleAdsStart);
  app.get("/api/connectors/google-ads/callback", googleAdsCallback);
  app.post("/api/connectors/google-ads/finalize", googleAdsFinalize);
  app.get("/api/connectors/google-analytics/start", railAwareGoogleStart("google_analytics", googleAnalyticsStart));
  app.get("/api/connectors/google-analytics/callback", googleAnalyticsCallback);
  app.post("/api/connectors/google-analytics/finalize", googleAnalyticsFinalize);
  app.get("/api/connectors/google-search-console/start", railAwareGoogleStart("google_search_console", googleSearchConsoleStart));
  app.get("/api/connectors/google-search-console/callback", googleSearchConsoleCallback);
  app.post("/api/connectors/google-search-console/finalize", googleSearchConsoleFinalize);
  app.get("/api/seo/search-console/summary", searchConsoleSummary);
  app.get("/api/geo/metrics", geoMetricsGet);
  app.get("/api/geo/evidence", geoEvidenceGet);
  app.get("/api/geo/prompts", geoPromptsGet);
  app.post("/api/geo/prompts", geoPromptCreate);
  app.post("/api/geo/prompts/suggest", geoPromptSuggest);
  app.post("/api/geo/prompts/starter", geoPromptStarter);
  app.post("/api/geo/prompts/accept", geoPromptAccept);
  app.delete("/api/geo/prompts/:id", geoPromptArchive);
  app.put("/api/geo/rivals", geoRivalsPut);
  app.post("/api/geo/rivals", geoRivalAdd);
  app.post("/api/geo/sweeps", geoSweepCreate);
  app.get("/api/geo/sweeps/:id", geoSweepGet);
  app.get("/api/geo/crawler-hits", geoCrawlerHitsGet);
  app.get("/api/geo/crawler-hits/bots/:bot", geoCrawlerBotGet);
  app.get("/api/geo/crawler-hits/setup", geoCrawlerSetupGet);
  app.post("/api/geo/crawler-hits/token", geoIngestTokenRotate);
  app.delete("/api/geo/crawler-hits/token", geoIngestTokenRevoke);
  app.post("/api/connectors/posthog/projects", posthogProjects);
  app.post("/api/connectors/posthog/connect", posthogConnect);
  app.post("/api/connectors/email", emailKeyConnect);
  app.delete("/api/connectors/email", emailKeyDisconnect);

  app.post("/api/connectors/sentry", sentryConnect);
  app.post("/api/connectors/figma", figmaConnect);
  app.post("/api/connectors/supabase/projects", supabaseProjects);
  app.post("/api/connectors/supabase/connect", supabaseConnect);
  app.post("/api/connectors/apple_ads/connect", appleAdsConnect);
  app.get("/api/connectors/google-sheets/start", googleSheetsStart);
  app.get("/api/connectors/google-sheets/callback", googleSheetsCallback);
  app.get("/api/connectors/google-calendar/start", googleCalendarStart);
  app.get("/api/connectors/google_sheets/start", googleSheetsStart);
  app.get("/api/connectors/google_calendar/start", googleCalendarStart);
  app.get("/api/connectors/google-calendar/callback", googleCalendarCallback);
  app.post("/api/connectors/google-calendar/finalize", googleCalendarFinalize);
  app.get("/api/connectors/meta_ads/start", metaAdsStart);
  app.get("/api/connectors/google_ads/start", googleAdsStart);
  app.get("/api/connectors/google_analytics/start", railAwareGoogleStart("google_analytics", googleAnalyticsStart));
  app.get("/api/connectors/google_search_console/start", railAwareGoogleStart("google_search_console", googleSearchConsoleStart));
  app.post("/api/connectors/operator-db", operatorDbConnect);
  app.get("/api/connectors/operator-db/access-log", operatorDbAccessLog);
  app.get("/api/connectors/operator-db/setup", operatorDbSetup);
  app.get("/api/connectors/operator-db/visibility", operatorDbVisibilityGet);
  app.put("/api/connectors/operator-db/visibility", operatorDbVisibilityPut);
  app.get("/api/connectors/operator-db/privacy", operatorDbPrivacyGet);
  app.put("/api/connectors/operator-db/privacy", operatorDbPrivacyPut);
  app.post("/api/connectors/operator-db/disconnect", operatorDbDisconnect);
  app.post("/api/connectors/operator-db/connector/pair-code", connectorPairCode);
  app.get("/api/connectors/operator-db/connector", connectorStatus);
  app.post("/api/connectors/operator-db/connector/remove", connectorRemove);
  app.post("/api/workspace/database/request-access", databaseRequestAccess);
  app.post("/api/connectors/stripe", stripeConnect);
  app.get("/api/connectors/social", socialList);
  app.post("/api/connectors/social", socialConnect);
  app.post("/api/connectors/social/disconnect", socialDisconnect);
  app.post("/api/social/propose", socialPropose);
  app.post("/api/social/posts/:id/cancel", socialPostCancel);
  app.post("/api/social/posts/:id/reschedule", socialPostReschedule);
  app.use(
    "/api/copilotkit",
    copilotkitRouter(() => `http://127.0.0.1:${process.env.PORT || "3001"}`),
  );
  app.post("/api/connectors/higgsfield", higgsfieldConnect);
  app.get("/api/connectors/higgsfield/start", higgsfieldStart);
  app.get("/api/connectors/higgsfield/callback", higgsfieldCallback);
  app.post("/api/connectors/higgsfield/disconnect", higgsfieldDisconnect);
  app.get("/api/connectors/composio/toolkits", composioToolkits);
  app.get("/api/connectors/shopify/install", shopifyInstall);
  app.get("/api/connectors/shopify/callback", shopifyCallback);
  app.get("/api/connectors/shopify/install/status", shopifyInstallStatus);
  app.post("/api/connectors/shopify/install/claim", shopifyClaim);
  app.get("/api/shopify/app-home", shopifyAppHome);
  app.post("/api/shopify/app-home/install", shopifyAppHomeInstall);
  app.post("/api/shopify/app-home/install/confirmation", shopifyAppHomeInstallConfirmation);
  app.post("/api/shopify/app-home/install/confirm", shopifyAppHomeInstallConfirm);
  app.post("/api/shopify/app-home/approvals/:decision_id", shopifyAppHomeDecide);
  app.post(
    "/api/shopify/app-home/billing",
    shopifyAppHomeBillingAuth,
    idempotencyFor("/api/shopify/app-home/billing"),
    shopifyAppHomeBilling,
  );
  app.post("/api/connectors/composio/:toolkit/connect", composioConnectStart);
  app.get("/api/connectors/composio/:toolkit/return", composioReturn);
  app.post("/api/connectors/composio/:toolkit/disconnect", composioDisconnectRoute);
  app.post("/api/connectors/composio/:toolkit/request", composioRequestApp);
  app.get("/api/connectors/tiktok-ads/ad-accounts", tiktokAdAccountsGet);
  app.post("/api/connectors/tiktok-ads/ad-accounts/refresh", tiktokAdAccountsRefresh);
  app.post("/api/connectors/tiktok-ads/ad-accounts/select", tiktokAdAccountsSelect);
  app.post("/api/connectors/tiktok-ads/ad-accounts/manual", tiktokAdAccountsManual);

  app.get("/api/connectors/pipedream/apps", pipedreamApps);
  app.post("/api/connectors/pipedream/:app/connect", pipedreamConnectStart);
  app.get("/api/connectors/pipedream/:app/return", pipedreamReturn);
  app.post("/api/connectors/pipedream/:app/disconnect", pipedreamDisconnect);

  app.get("/api/connectors/github/manifest-init", githubManifestInit);
  app.get("/api/connectors/github/manifest-callback", githubManifestCallback);

  app.get("/api/connectors/x_ads/start", xAdsStart);
  app.get("/api/connectors/x_ads/callback", xAdsCallback);
  app.post("/api/connectors/x_ads/disconnect", xAdsDisconnect);
  app.get("/api/connectors/:connector/start", connectorStart);
  app.get("/api/connectors/:connector/callback", connectorCallback);
  app.post("/api/connectors/:connector/complete", connectorComplete);
  app.post("/api/connectors/:connector/disconnect", connectorDisconnect);

  app.get("/api/approvals", approvalsList);
  app.get("/api/channels", channelsList);
  app.post("/api/channels/site-rescan", siteRescan);
  app.get("/api/channels/chatgpt_ads/campaigns/:campaignId/report", chatgptReport);
  app.get("/api/ads/chatgpt/campaigns/:bindingId/report", chatgptBoundRoute(chatgptReport));
  app.get("/api/channels/chatgpt_ads/locations", chatgptLocations);
  app.get("/api/channels/:slug/ad-locations", adLocationsStatus);
  app.get("/api/channels/:slug/ad-locations/suggestions", adLocationsSuggestions);
  app.get("/api/channels/tiktok_ads/ad-locations/search", tiktokAdLocationsSearch);
  app.get("/api/channels/tiktok_ads/analytics/entities", tiktokAnalyticsRead);
  app.get("/api/channels/x_ads/analytics/entities", xAnalyticsRead);
  app.get("/api/channels/reddit_ads/analytics/entities", redditAnalyticsRead);
  app.get("/api/channels/linkedin_ads/analytics/ads", linkedinAdAnalyticsRead);
  app.get("/api/channels/tiktok_ads/campaign-options", tiktokCampaignOptions);
  app.get("/api/channels/tiktok_ads/campaigns/:campaignId", tiktokCampaignDetail);
  app.post("/api/channels/tiktok_ads/campaigns", tiktokCampaignCreate);
  app.post("/api/channels/tiktok_ads/campaign-edits", tiktokCampaignEdit);
  app.post("/api/channels/tiktok_ads/campaign-videos", tiktokCampaignVideo);
  app.get("/api/channels/tiktok_ads/campaign-videos", tiktokCampaignVideoLibrary);
  app.get("/api/channels/x_ads/ad-locations/search", xAdLocationsSearch);
  app.get("/api/channels/:slug/ad-locations/search", adLocationsSearch);
  app.post("/api/channels/:slug/ad-locations", adLocationsSave);
  app.get("/api/channels/linkedin_ads/actions/:actionId/review", authMiddleware, linkedinReviewAction);
  app.get("/api/channels/linkedin_ads/actions/:actionId/targeting", authMiddleware, linkedinSearchTargeting);
  app.get("/api/channels/linkedin_ads/actions/:actionId/locations", authMiddleware, linkedinSearchLocations);
  app.get("/api/channels/linkedin_ads/actions/:actionId/post-preview", authMiddleware, linkedinPreviewPost);
  app.get("/api/channels/linkedin_ads/actions/:actionId/posts", authMiddleware, linkedinListPosts);
  app.post("/api/channels/linkedin_ads/actions/:actionId/prepare", authMiddleware, linkedinPrepareAction);
  app.post("/api/channels/linkedin_ads/actions/:actionId/create-audiences", authMiddleware, linkedinCreateAudiences);
  app.post("/api/channels/linkedin_ads/campaigns/:campaignId/propose-pause", authMiddleware, linkedinProposePause);
  app.post("/api/channels/linkedin_ads/campaigns/:campaignId/propose-resume", authMiddleware, linkedinProposeResume);
  app.post("/api/channels/linkedin_ads/campaigns/:campaignId/propose-archive", authMiddleware, linkedinProposeArchive);
  app.post("/api/channels/linkedin_ads/campaigns/:campaignId/propose-duplicate", authMiddleware, linkedinProposeCampaignDuplicate);
  app.post("/api/channels/linkedin_ads/groups/:groupId/propose-status", authMiddleware, linkedinProposeGroupStatus);
  app.post("/api/channels/linkedin_ads/groups/:groupId/propose-duplicate", authMiddleware, linkedinProposeGroupDuplicate);
  app.post("/api/channels/linkedin_ads/ads/:creativeId/propose-status", authMiddleware, linkedinProposeAdStatus);
  app.post("/api/channels/linkedin_ads/campaign-drafts", authMiddleware, linkedinFileCampaignDraft);
  app.get("/api/channels/chatgpt_ads/actions/:actionId/review", authMiddleware, chatgptReviewAction);
  app.post("/api/channels/chatgpt_ads/actions/:actionId/prepare", authMiddleware, chatgptPrepareAction);
  app.post("/api/channels/chatgpt_ads/actions/:actionId/ad-image", authMiddleware, chatgptCreateAdImage);
  app.get("/api/channels/chatgpt_ads/campaigns/:campaignId/launch", authMiddleware, chatgptLaunchSummary);
  app.get("/api/ads/chatgpt/campaigns/:bindingId/launch", authMiddleware, chatgptBoundRoute(chatgptLaunchSummary));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/launch", authMiddleware, chatgptLaunch);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/launch", authMiddleware, chatgptBoundRoute(chatgptLaunch));
  app.get("/api/channels/chatgpt_ads/resources", chatgptResources);
  app.get("/api/ads/chatgpt/locations",chatgptLocations);
  app.get("/api/channels/chatgpt_ads/campaigns/:campaignId/resources", chatgptCampaignResources);
  app.get("/api/ads/chatgpt/campaigns/:bindingId/resources", chatgptBoundRoute(chatgptCampaignResources));
  app.get("/api/channels/chatgpt_ads/campaigns/:campaignId", chatgptReadCampaign);
  app.get("/api/ads/chatgpt/campaigns/:bindingId", chatgptBoundRoute(chatgptReadCampaign));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/ad-groups/:groupId/edit", authMiddleware, chatgptEditGroup);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/ad-groups/:groupId/edit", authMiddleware, chatgptBoundRoute(chatgptEditGroup));
  app.get("/api/channels/chatgpt_ads/safety", chatgptSafety);
  app.get("/api/ads/campaigns", authMiddleware, adsBoundCampaigns);
  app.get("/api/ads/campaigns/:bindingId/launch", authMiddleware, adsCampaignLaunchSummary);
  app.post("/api/ads/campaigns/:bindingId/launch", authMiddleware, adsCampaignLaunch);
  app.post("/api/ads/campaigns/:bindingId/pause", authMiddleware, adsCampaignPause);
  app.get("/api/ads/accounts/:platform", authMiddleware, adsAccounts);
  app.get("/api/ads/accounts/:platform/available", authMiddleware, adsAvailableAccounts);
  app.post("/api/ads/accounts/:platform/connect", authMiddleware, adsConnectAccount);
  app.post("/api/ads/accounts/:platform/select", authMiddleware, adsSelectAccount);
  app.post("/api/ads/accounts/:platform/disable", authMiddleware, adsDisableAccount);
  app.post("/api/ads/accounts/:platform/enable", authMiddleware, adsEnableAccount);
  app.post("/api/ads/accounts/:platform/campaigns/import", authMiddleware, adsImportCampaign);
  app.get("/api/ads/wallet/consent", authMiddleware, adsWalletConsent);
  app.post("/api/ads/wallet/consent", authMiddleware, adsWalletConsent);
  app.get("/api/ads/wallet/reservations", authMiddleware, adsWalletReservations);
  app.get("/api/ads/wallet", adsWallet);
  app.post("/api/ads/wallet/checkout", authMiddleware, adsFund);
  app.post("/api/ads/wallet/disable-refill", authMiddleware, adsDisableRefill);
  app.get("/api/ads/wallet/payment-methods", authMiddleware, adsCards);
  app.post("/api/ads/wallet/payment-methods/select", authMiddleware, adsCardSelect);
  app.post("/api/ads/wallet/setup-intent", authMiddleware, adsCardSetup);
  app.post("/api/ads/wallet/setup-intent/complete", authMiddleware, adsCardSetupComplete);
  app.post("/api/ads/wallet/pay", authMiddleware, adsCardPay);
  app.get("/api/ads/wallet/orders/:orderId", authMiddleware, adsOrderStatus);
  app.get("/api/channels/chatgpt_ads/wallet", chatgptWallet);
  app.post("/api/channels/chatgpt_ads/wallet/checkout", authMiddleware, chatgptFund);
  app.post("/api/channels/chatgpt_ads/wallet/disable-refill", authMiddleware, chatgptDisableRefill);
  app.get("/api/channels/chatgpt_ads/wallet/payment-methods", authMiddleware, chatgptCards);
  app.post("/api/channels/chatgpt_ads/wallet/payment-methods/select", authMiddleware, chatgptCardSelect);
  app.post("/api/channels/chatgpt_ads/wallet/setup-intent", authMiddleware, chatgptCardSetup);
  app.post("/api/channels/chatgpt_ads/wallet/setup-intent/complete", authMiddleware, chatgptCardSetupComplete);
  app.post("/api/channels/chatgpt_ads/wallet/pay", authMiddleware, chatgptCardPay);
  app.get("/api/channels/chatgpt_ads/wallet/orders/:orderId", authMiddleware, chatgptOrderStatus);
  app.get("/api/channels/chatgpt_ads/campaigns/:campaignId/entities", chatgptEntities);
  app.get("/api/ads/chatgpt/campaigns/:bindingId/entities", chatgptBoundRoute(chatgptEntities));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/ad-groups", authMiddleware, chatgptCreateGroup);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/ad-groups", authMiddleware, chatgptBoundRoute(chatgptCreateGroup));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/ad-groups/:groupId", authMiddleware, chatgptUpdateGroup);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/ad-groups/:groupId", authMiddleware, chatgptBoundRoute(chatgptUpdateGroup));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/creatives", authMiddleware, chatgptSaveCreative);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/creatives", authMiddleware, chatgptBoundRoute(chatgptSaveCreative));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/creatives/:adId", authMiddleware, chatgptSaveCreative);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/creatives/:adId", authMiddleware, chatgptBoundRoute(chatgptSaveCreative));
  app.post("/api/channels/chatgpt_ads/campaigns", authMiddleware, chatgptCreateCampaign);
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId", authMiddleware, chatgptUpdateCampaign);
  app.post("/api/ads/chatgpt/campaigns/:bindingId", authMiddleware, chatgptBoundRoute(chatgptUpdateCampaign));
  app.post("/api/channels/chatgpt_ads/campaigns/:campaignId/ads/:adId", authMiddleware, chatgptUpdateAd);
  app.post("/api/ads/chatgpt/campaigns/:bindingId/ads/:adId", authMiddleware, chatgptBoundRoute(chatgptUpdateAd));
  app.get("/api/channels/pinterest_organic/readiness", pinterestReadinessGet);
  app.post("/api/channels/pinterest_organic/boards", pinterestBoardCreate);
  app.get("/api/channels/pinterest_organic/boards/search", pinterestBoardSearch);
  app.get("/api/channels/generated_video/starters", startersRead);
  app.post("/api/channels/generated_video/starters", startersStart);
  app.get("/api/channels/generated_video/studio", videoStudioRead);
  app.post("/api/channels/generated_video/studio/messages", videoStudioSend);
  app.post("/api/channels/generated_video/studio/render", videoStudioRender);
  app.post("/api/channels/generated_video/studio/script", videoStudioScript);
  app.get("/api/channels/generated_video/studio/prompt", videoStudioPrompt);
  app.get("/api/channels/generated_video/studio/threads", videoStudioThreads);
  app.get("/api/channels/generated_video/studio/videos", videoStudioGallery);
  app.get("/api/channels/generated_video/studio/post-targets", videoStudioPostTargets);
  app.post("/api/channels/generated_video/studio/videos/:id/post", videoStudioPost);
  app.post("/api/channels/:slug/run", channelRun);
  app.post("/api/channels/:slug/preview-on-open", channelPreviewOnOpen);
  app.get("/api/channels/:slug/top-actions/runs/:run_id", topActionRun);
  app.get("/api/channels/:slug/top-actions/:key/context", topActionContext);
  app.post("/api/channels/:slug/top-actions/:key", startTopAction);
  app.get("/api/channels/meta_ads/boost/options", metaBoostOptions);
  app.post("/api/channels/meta_ads/boost", metaBoostCreate);
  app.get("/api/channels/:channel/analytics/entities", paidAnalyticsRead);
  app.get("/api/channels/meta_ads/locations", metaEditorLocations);
  app.get("/api/channels/meta_ads/campaigns/:campaignId", metaEditorRead);
  app.post("/api/channels/meta_ads/campaigns", metaEditorCreate);
  app.post("/api/channels/meta_ads/campaigns/:campaignId", metaEditorSave);
  app.post("/api/channels/meta_ads/campaigns/:campaignId/ad-sets", metaEditorCreateAdSet);
  app.post("/api/channels/meta_ads/campaigns/:campaignId/ads", metaEditorCreateAd);
  app.get("/api/channels/google_ads/locations", googleEditorLocations);
  app.get("/api/channels/google_ads/campaigns/:campaignId", googleEditorRead);
  app.post("/api/channels/google_ads/campaigns", googleEditorCreate);
  app.post("/api/channels/google_ads/campaigns/:campaignId", googleEditorSave);
  app.post("/api/channels/google_ads/campaigns/:campaignId/ad-groups", googleEditorCreateAdGroup);
  app.post("/api/channels/google_ads/campaigns/:campaignId/ads", googleEditorCreateAd);
  app.get("/api/channels/youtube_ads/locations", youtubeEditorLocations);
  app.get("/api/channels/youtube_ads/campaigns/:campaignId", youtubeEditorRead);
  app.post("/api/channels/youtube_ads/campaigns", youtubeEditorCreate);
  app.post("/api/channels/youtube_ads/campaigns/:campaignId", youtubeEditorSave);
  app.post("/api/channels/tiktok_organic/drafts", tiktokSendToDrafts);
  app.post("/api/channels/:slug/checks/:key/done", channelCheckDone);
  app.post("/api/channels/:slug/drafts/revise", channelReviseDraft);
  app.post("/api/channels/:slug/actions/:id/blank-suggestions", channelBlankSuggestions);
  app.put("/api/channels/:slug/monthly-budget", authMiddleware, putChannelMonthlyBudget);
  app.get("/api/channels/:slug/actions", channelActionsList);
  app.post("/api/channels/:slug/actions/release-held", channelActionsReleaseHeld);
  app.get("/api/channels/:slug/metrics", channelMetricsList);
  app.get("/api/channels/:slug/settings", channelSettingsGet);
  app.put("/api/channels/:slug/settings/:fieldId", channelSettingsPut);
  app.get("/api/channels/:slug/history", channelHistoryGet);
  app.post("/api/channel-actions/:id", channelActionSet);
  app.post("/api/channel-actions/:id/redo", channelActionRedo);
  app.get("/api/channel-actions/post-draft/video", postDraftVideoUrl);
  app.post("/api/channel-actions/post-draft/photo", postDraftPhotoUpload);
  app.post("/api/channel-actions/post-draft/photo/import", postDraftPhotoImport);
  app.get("/api/channel-actions/:id/video-card", channelVideoCardRead);
  app.get("/api/channel-actions/:id/card", channelHistoryCardRead);
  app.get("/api/channel-actions/:id/post-draft", channelPostDraftRead);
  app.put("/api/channel-actions/:id/post-draft", channelPostDraftSave);
  app.get("/api/channel-actions/:id/ad-review", channelAdReview);
  app.post("/api/channel-actions/:id/ad-review", channelAdRevise);
  app.post("/api/channel-actions/:id/ad-review/preview", channelAdPreview);
  app.post("/api/channel-actions/:id/steps", channelActionSteps);
  app.post("/api/channels/actions/:id/publish-on", channelActionPublishOn);
  app.post("/api/channel-actions/:id/approve", channelActionApprove);
  app.use("/api/reddit", redditWorkspaceV2Gate);
  app.use("/api/reddit", redditWriteRoleGate);
  app.get("/api/reddit/workspace", redditWorkspaceGet);
  app.post("/api/reddit/workspace/suggest", redditWorkspaceSuggest);
  app.post("/api/reddit/workspace/keywords", redditKeywordCreate);
  app.patch("/api/reddit/workspace/keywords/:id", redditKeywordUpdate);
  app.post("/api/reddit/workspace/competitors", redditCompetitorCreate);
  app.patch("/api/reddit/workspace/competitors/:id", redditCompetitorUpdate);
  app.post("/api/reddit/workspace/communities", redditCommunityCreate);
  app.patch("/api/reddit/workspace/communities/:id", redditCommunityUpdate);
  app.delete("/api/reddit/workspace/:kind/:id", redditWorkspaceDelete);
  app.get("/api/reddit/insights", redditInsightsGet);
  app.post("/api/reddit/sweep", redditSweepPost);
  app.post("/api/reddit/threads/:id/draft", redditThreadDraftPost);
  app.patch("/api/reddit/threads/:id", redditThreadUpdate);
  app.post("/api/approvals/:decision_id/redo", approvalsRedoRequest);
  app.post("/api/approvals/:decision_id/archive", approvalsArchive);
  app.post("/api/approvals/:decision_id/snooze", approvalsSnooze);
  app.post("/api/approvals/:decision_id/unsnooze", approvalsUnsnooze);
  app.get("/api/approvals/history", approvalsHistory);
  app.post("/api/approvals/:decision_id/revision", approvalsRevisionRequest);
  app.get("/api/approvals/:decision_id/revision-transcript", approvalsRevisionTranscript);
  app.post("/api/approvals/:decision_id/approve", approvalsApprove);
  app.post("/api/approvals/:decision_id/reject", approvalsReject);
  app.post("/api/approvals/:decision_id/approve-move", approvalsApproveMove);
  app.post("/api/approvals/:decision_id/reject-move", approvalsRejectMove);
  app.post("/api/approvals/:decision_id/move-fit", approvalsMoveFit);
  app.get("/api/approvals/:decision_id/find-money", approvalsFindMoney);
  app.post("/api/approvals/:decision_id/finalize-evidence", approvalsFinalizeEvidence);
  app.post("/api/approvals/approve-batch", approvalsApproveBatch);
  app.post("/api/approvals/reject-batch", approvalsRejectBatch);

  app.post("/api/humans/applications", postHumanApplication);
  app.get("/api/humans/applications/:application_id/messages", getHumanApplicationMessages);
  app.post("/api/humans/applications/:application_id/messages", postHumanApplicationMessage);

  app.post("/api/creators/:human_member_id/threads", openCreatorThread);
  app.post("/api/creators/:human_member_id/offers", postStorefrontOffer);
  app.get("/api/creators/threads", getBusinessCreatorThreads);
  app.get("/api/creators/invites/threads", getInviteConversations);
  app.get("/api/creators/invites/:invite_id/messages", getInviteMessages);
  app.post("/api/creators/invites/:invite_id/messages", postInviteMessageRoute);
  app.get("/api/creators/threads/:thread_id/messages", getCreatorThreadMessages);
  app.post("/api/creators/threads/:thread_id/messages", postCreatorThreadMessageRoute);
  app.get("/api/creators/threads/:thread_id/offers", getCreatorThreadOffers);
  app.post("/api/creators/threads/:thread_id/offers", postThreadOffer);
  app.get("/api/creators/offers/:offer_id", getCreatorOffer);
  app.post("/api/creators/offers/:offer_id/accept", acceptCreatorOfferRoute);
  app.post("/api/creators/offers/:offer_id/decline", declineCreatorOfferRoute);
  app.post("/api/creators/offers/:offer_id/withdraw", withdrawCreatorOfferRoute);
  app.post("/api/creators/offers/:offer_id/checkout", postCreatorOfferCheckout);
  app.get("/api/approvals/autonomy", autonomyList);
  app.post("/api/approvals/autonomy", autonomySet);
  app.get("/api/approvals/:decision_id", approvalsOne);
  app.post("/api/approvals/ads-autopilot", approvalsAdsAutopilot);

  app.get("/api/artifacts", artifactsList);
  app.post("/api/artifacts/:id/apply", artifactsApply);
  app.post("/api/artifacts/:id/reject", artifactsReject);

  app.get("/api/a2a/agent-cards", a2aAgentCards);
  app.post("/api/a2a/dispatch", a2aDispatch);

  app.get("/api/memory/notes", memoryNotesList);
  app.get("/api/memory/notes/conflicts", memoryConflictsList);
  app.get("/api/memory/dream-cycle-status", memoryDreamCycleStatus);
  app.get("/api/memory/notes/:id", memoryNoteGet);
  const skillDraftLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => tenantKey(req, "ip-skill-draft:"),
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "10 skill drafts/min. Slow down" },
      }),
  });
  app.post("/api/memory/skills/draft", authMiddleware, skillDraftLimiter, memorySkillDraft);
  app.post("/api/memory/notes", memoryNoteUpsert);
  app.get("/api/routines", routinesList);
  app.post("/api/routines", routineAuthor);
  app.post("/api/routines/:id/approve", routineApprove);
  app.put("/api/memory/notes/:id", memoryNoteUpsert);
  app.delete("/api/memory/notes/:id", memoryNoteDelete);
  app.post("/api/memory/notes/:id/unsupersede", memoryNoteUnsupersede);
  app.get("/api/memory/writes", memoryWritesGet);
  app.get("/api/memory/recent-writes", memoryRecentWrites);
  app.post("/api/memory/writes/:id/restore", memoryWriteRestore);
  app.post("/api/memory/notes/:id/forget", memoryNoteForget);
  app.post("/api/memory/forget/undo", memoryForgetUndo);
  app.post("/api/memory/notes/:id/undo-update", memoryNoteUndoUpdate);
  app.get("/api/memory/conflicts", memoryOpenConflicts);
  app.post("/api/memory/conflicts/:pair_id/keep", memoryConflictKeep);
  app.get("/api/extension/consent", getExtensionConsent);
  app.post("/api/extension/consent", postExtensionConsent);
  app.delete("/api/extension/consent", deleteExtensionConsent);
  const extensionScreenshotLimiter = rateLimit({
    windowMs: 60_000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => "xshot:" + (req.ip ?? "unknown"),
  });
  app.post(
    "/api/extension/screenshot",
    extensionScreenshotLimiter,
    ...extensionScreenshotChain,
  );

  const extensionOpsLimiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => "xops:" + (req.ip ?? "unknown"),
  });
  app.post("/api/extension/sessions", extensionOpsLimiter, postExtensionSession);
  app.post(
    "/api/extension/sessions/:id/heartbeat",
    extensionOpsLimiter,
    postExtensionSessionHeartbeat,
  );
  app.delete("/api/extension/sessions/:id", extensionOpsLimiter, deleteExtensionSession);
  app.get("/api/extension/ops/next", extensionOpsLimiter, getExtensionNextOp);
  app.post("/api/extension/ops/:id/result", extensionOpsLimiter, postExtensionOpResult);

  const extensionConnectStartLimiter = rateLimit({
    windowMs: 60_000,
    limit: 6,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => {
      const bearer = req.headers.authorization;
      if (bearer && bearer.length > 16) {
        return "xconnstart:s:" + createHash("sha256").update(bearer).digest("hex").slice(0, 32);
      }
      return "xconnstart:ip:" + (req.ip ?? "unknown");
    },
  });
  const extensionConnectRedeemLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => "xconnredeem:" + (req.ip ?? "unknown"),
  });
  app.post(
    "/api/extension/connect/start",
    extensionConnectStartLimiter,
    extensionConnectStart,
  );
  app.post(
    "/api/extension/connect/redeem",
    extensionConnectRedeemLimiter,
    extensionConnectRedeem,
  );

  app.get("/api/personalization", getPersonalization);
  app.put("/api/personalization", putPersonalization);
  app.get("/api/rules", rulesList);
  app.post("/api/rules", rulesAdd);
  app.delete("/api/rules", rulesDeleteAll);
  app.put("/api/rules/settings", rulesSettings);
  app.get("/api/rules/ad-guard", rulesAdGuardGet);
  app.put("/api/rules/ad-guard", rulesAdGuardPut);
  app.post("/api/rules/:id/activate", rulesActivate);
  app.post("/api/rules/:id/dismiss", rulesDismiss);
  app.patch("/api/rules/:id", rulesEdit);
  app.delete("/api/rules/:id", rulesDelete);
  app.post("/api/agents/feedback", agentFeedbackRule);
  app.get("/api/personalization/summary", getPersonalizationSummary);
  app.get("/api/workspace/brand-kit", getBrandKit);
  app.put("/api/workspace/brand-kit", putBrandKit);
  app.delete("/api/workspace/brand-kit", deleteBrandKit);
  app.get("/api/personalization/documents", listPersonalizationDocuments);
  app.post("/api/personalization/documents", ...personalizationUploadChain);
  app.post("/api/personalization/documents/:id/replace", ...personalizationReplaceChain);
  app.post("/api/personalization/documents/:id/archive", archivePersonalizationDocument);
  app.post("/api/personalization/documents/:id/restore", restorePersonalizationDocument);
  app.delete("/api/personalization/documents/:id", deletePersonalizationDocument);
  app.get("/api/personalization/documents/:id/url", personalizationDocumentUrl);
  app.post("/api/knowledge/import/:id/read", readImport);
  app.get("/api/knowledge/imports", listImports);
  app.delete("/api/knowledge/imports/:id", deleteImport);
  app.delete("/api/knowledge/facts/:id", deleteImportedFact);
  app.post("/api/memory/regenerate-anchor", memoryRegenerateAnchor);
  app.post("/api/memory/search", memorySearch);

  app.get("/api/snapshots", listSnapshots);
  app.post("/api/snapshots", submitSnapshot);

  app.post("/api/feedback", feedbackSubmit);
  app.get("/api/feedback/mine", feedbackMine);
  app.post("/api/feedback/product", feedbackProductSubmit);
  app.get("/api/feedback/product/mine", feedbackProductMine);
  app.post("/api/feedback/product/seen", feedbackProductSeen);
  app.get("/api/team-notes/prefs", teamNotePrefsGet);
  app.put("/api/team-notes/prefs", teamNotePrefsPut);
  app.post("/api/team-notes/:messageId/shown", teamNoteShown);
  app.post("/api/team-notes/:messageId/send", teamNoteSend);
  app.post("/api/team-notes/:messageId/dismiss", teamNoteDismiss);
  app.post("/api/team-notes/:messageId/opened", teamNoteOpened);

  app.post("/api/events/ingest", eventsIngest);

  app.get("/api/workspace/bootstrap", workspaceBootstrap);
  app.get("/api/workspace/tree", workspaceTree);
  app.post("/api/workspace/agent-seen", workspaceAgentSeen);
  app.post("/api/workspace/opened", workspaceOpened);
  app.post("/api/workspace/thread-seen", workspaceThreadSeen);
  app.get("/api/workspace/threads", workspaceListThreads);
  app.get("/api/workspace/channel-threads", workspaceListChannelThreads);
  app.get("/api/workspace/tabs-session", workspaceTabsSessionGet);
  app.post("/api/workspace/tabs-session", workspaceTabsSessionPost);
  app.get("/api/workspace/agent-pins", workspaceAgentPinsGet);
  app.put("/api/workspace/agent-pins", workspaceAgentPinsPut);
  app.post("/api/workspace/agent-unread", workspaceAgentUnread);

  app.patch("/api/tenant/me/settings", patchTenantSettings);
  app.get("/api/tenant/me/reporting-timezone", getReportingTimezone);
  app.patch("/api/tenant/me/reporting-timezone", patchReportingTimezone);
  app.get("/api/tenant/me/data-notes", listDataNotesHandler);
  app.delete("/api/tenant/me/data-notes/:id", deleteDataNoteHandler);
  app.get("/api/tenant/me/email-allowlist", listEmailAllowlist);
  app.post("/api/tenant/me/email-allowlist", addEmailAllowlistEntry);
  app.delete("/api/tenant/me/email-allowlist/:id", removeEmailAllowlistEntry);
  app.get("/api/tenant/me/email-members", listEmailMembers);
  app.post("/api/tenant/me/email-members", setEmailMemberEnabled);
  app.get("/api/tenant/me/pm-hybrid-surface", getPmHybridSurface);
  app.get("/api/workspace/status-counters", workspaceStatusCounters);
  app.get("/api/website/overview", getWebsiteOverviewHandler);
  app.post("/api/website/settings", setWebsiteSettingsHandler);
  app.get("/api/website/site-functions", getSiteFunctionsHandler);
  app.get("/api/website/site-functions/:name/runs", getSiteFunctionRunsHandler);
  app.put("/api/website/site-secrets/:name", putSiteSecretHandler);
  app.delete("/api/website/site-secrets/:name", deleteSiteSecretHandler);
  app.post("/api/website/site-schedules/:name", setSiteScheduleHandler);
  app.get("/api/website/site-analytics", getSiteAnalyticsHandler);
  app.get("/api/website/custom-domains", getCustomDomainsHandler);
  app.get("/api/website/custom-domains/dns-provider", getCustomDomainDnsProviderHandler);
  app.post("/api/website/custom-domains", addCustomDomainHandler);
  app.post("/api/website/custom-domains/:id/verify", verifyCustomDomainHandler);
  app.delete("/api/website/custom-domains/:id", deleteCustomDomainHandler);
  app.get("/api/website/site-seo", getSiteSeoHandler);
  app.post("/api/website/site-seo/refresh", refreshSiteSeoHandler);
  app.get("/api/website/builtin-url", getBuiltinUrlHandler);
  app.post("/api/website/builtin-url", setBuiltinUrlHandler);
  app.post("/api/website/builtin-url/ensure", ensureBuiltinUrlHandler);
  app.delete("/api/website/builtin-url", deleteBuiltinUrlHandler);
  app.get("/api/website/edits", getWebsiteEditsHandler);
  app.post("/api/website/edits", setWebsiteEditHandler);
  app.post("/api/website/resolve-edit", resolveWebsiteEditHandler);
  app.post("/api/website/resolve-chat-edit", resolveChatWebsiteEditHandler);
  app.post("/api/website/publish", publishWebsiteEditsHandler);
  app.post("/api/website/unpublish", unpublishWebsiteEditsHandler);
  app.get("/api/website/publish-status", websitePublishStatusHandler);
  app.get("/api/website/pending", websitePendingChangesHandler);
  app.post("/api/website/discard", discardWebsiteEditsHandler);
  app.get("/api/website/edits/published", getPublishedWebsiteEditsHandler);
  app.get("/api/website/app-catalog", getWebsiteAppCatalogHandler);
  app.get("/api/website/app-rows", getWebsiteAppRowsHandler);
  const websiteDataMutationLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.auth?.tenant_id ? `t:${req.auth.tenant_id}` : `ip:${req.ip ?? "unknown"}`,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({ error: { code: "rate_limited", message: "Too many data changes; slow down." } }),
  });
  app.post("/api/website/app-rows", authMiddleware, websiteDataMutationLimiter, createWebsiteAppRowHandler);
  app.patch("/api/website/app-rows", authMiddleware, websiteDataMutationLimiter, updateWebsiteAppRowHandler);
  app.delete("/api/website/app-rows", authMiddleware, websiteDataMutationLimiter, deleteWebsiteAppRowHandler);
  app.get("/api/website/app-invites", listWebsiteAppInvitesHandler);
  app.post("/api/website/app-invites", authMiddleware, websiteDataMutationLimiter, createWebsiteAppInviteHandler);
  app.post("/api/website/app-invites/:id/revoke", authMiddleware, websiteDataMutationLimiter, revokeWebsiteAppInviteHandler);
  app.get("/api/workspace/activation", workspaceActivation);
  app.post("/api/workspace/onboarding-memory/retry", onboardingMemoryRetry);
  app.get("/api/workspace/inbox-addresses", workspaceInboxAddresses);

  app.get("/api/workspace/morning-brief", workspaceMorningBrief);
  app.get("/api/workspace/growth-strategy", workspaceGrowthStrategy);
  app.post("/api/workspace/growth-strategy/draft", workspaceGrowthStrategyDraft);
  app.post("/api/workspace/growth-strategy/apply", workspaceGrowthStrategyApply);
  app.post("/api/workspace/growth-strategy/accept", workspaceGrowthStrategyAccept);
  app.post("/api/workspace/decisions/:id/check", decisionCheck);
  app.get("/api/workspace/growth/plan", (req, res) => withMetaCaller("growth_page", () => getGrowthPlan(req, res)));
  app.post("/api/workspace/growth/goals/:id/accept", postAcceptSuggestedGoal);
  app.post("/api/workspace/growth/conflicts/:hypothesisId/keep", postKeepPlanConflict);
  app.post("/api/workspace/growth/constraint/agree", authMiddleware, postConstraintAgree);
  app.post("/api/workspace/growth/constraint/founder", authMiddleware, postConstraintFounder);
  app.post("/api/workspace/growth/constraint/switch", authMiddleware, postConstraintSwitch);
  app.get("/api/workspace/growth/open-cards", authMiddleware, getGrowthOpenCards);
  app.get("/api/workspace/growth/done-for-you", authMiddleware, getDoneForYou);
  app.post("/api/workspace/growth/done-for-you", authMiddleware, postDoneForYou);
  app.get("/api/workspace/growth/done-week", authMiddleware, getGrowthDoneWeek);
  app.get("/api/workspace/growth/tests", authMiddleware, getGrowthTests);
  app.post("/api/workspace/growth/cards/:id/copied", authMiddleware, postGrowthCardCopied);
  app.put("/api/workspace/growth/autopilot", putGrowthAutopilot);
  app.get("/api/workspace/growth/scheduler", getGrowthScheduler);
  app.post("/api/workspace/growth/goals/:id/undo-cgo-change", postUndoCgoChange);
  app.post("/api/workspace/growth/autopilot-mistake", postAutopilotMistake);
  app.get("/api/workspace/growth/questions", getGrowthQuestions);
  app.get("/api/workspace/growth/ad-holds", getGrowthAdHolds);
  app.post("/api/workspace/growth/questions/:id/answer", postGrowthQuestionAnswer);
  app.get("/api/workspace/growth/you-asked", getGrowthYouAsked);
  app.post("/api/workspace/channel-seen", postChannelSeen);
  app.get("/api/workspace/ad-budget", authMiddleware, getAdBudget);
  app.get("/api/workspace/growth-controls/proposals/:decision_id", authMiddleware, getBusinessControlsProposal);
  app.get("/api/workspace/growth-controls", authMiddleware, getGrowthControls);
  app.put("/api/workspace/growth-controls", authMiddleware, putGrowthControls);
  app.post("/api/workspace/growth-controls/experiments", authMiddleware, postGrowthExperiment);
  app.get("/api/workspace/ad-budget/ledger", authMiddleware, getAdBudgetLedger);
  app.get("/api/workspace/ad-budget/channels", authMiddleware, getAdBudgetChannels);
  app.post("/api/workspace/ad-budget", authMiddleware, postAdBudget);
  app.patch("/api/workspace/ad-budget/:id", authMiddleware, patchAdBudget);
  app.post("/api/workspace/ad-budget/:id/stop", authMiddleware, postAdBudgetStop);
  app.post("/api/workspace/ad-budget/:id/human-actions", authMiddleware, postAdBudgetHumanAction);
  app.post("/api/workspace/ad-budget/changes/:id/undo", authMiddleware, postAdChangeUndo);
  app.get("/api/workspace/next-tiles", getNextTiles);
  app.post("/api/workspace/next-tiles/mark", postNextTilesMark);
  app.get("/api/workspace/setup", getSetup);
  app.post("/api/workspace/setup/progress", postSetupProgress);
  app.post("/api/workspace/setup/draft", postSetupDraft);
  app.post(
    "/api/workspace/growth/channels/:slug/autorun",
    authMiddleware,
    postGrowthChannelAutorun,
  );
  app.post(
    "/api/workspace/growth/channels/:slug/plan",
    authMiddleware,
    postGrowthChannelPlan,
  );
  app.get("/api/workspace/growth-interview", getGrowthInterview);
  app.post("/api/workspace/growth-interview/answer", postGrowthInterviewAnswer);
  app.post("/api/workspace/growth-interview/skip", postGrowthInterviewSkip);
  app.post("/api/workspace/growth-intake/research", postGrowthIntakeResearch);
  app.get("/api/workspace/growth-intake/learned", getGrowthIntakeLearned);
  app.post("/api/workspace/growth-strategy/reset", postGrowthStrategyReset);

  app.get("/api/workspace/notetaker-settings", workspaceNotetakerSettingsGet);
  app.put("/api/workspace/notetaker-settings", workspaceNotetakerSettingsPut);
  app.put("/api/workspace/notetaker-recap", workspaceNotetakerRecapPut);
  app.get("/api/workspace/slack-channels", workspaceSlackChannelsGet);
  app.post("/api/workspace/notetaker-join", workspaceNotetakerJoin);
  app.get("/api/workspace/notetaker-meetings", workspaceNotetakerMeetings);
  app.get("/api/workspace/notetaker-meetings/:botId/atoms", workspaceNotetakerAtoms);
  app.get("/api/workspace/notetaker-meetings/:botId/notes", workspaceNotetakerNotes);
  app.get("/api/workspace/memory-cards", workspaceMemoryCardsList);
  app.post("/api/workspace/memory-cards/:id/approve", workspaceMemoryCardApprove);
  app.post("/api/workspace/memory-cards/:id/ignore", workspaceMemoryCardIgnore);

  app.post("/api/workspace/export-github", authMiddleware, postWorkspaceExportGithub);
  app.get("/api/workspace/export-github", authMiddleware, getWorkspaceExportGithubStatus);
  app.get("/api/workspace/export-github/dest", authMiddleware, getWorkspaceExportGithubDest);
  app.get("/api/workspace/app-code/tree", authMiddleware, getWorkspaceAppCodeTree);
  app.get("/api/workspace/app-code/file", authMiddleware, getWorkspaceAppCodeFile);
  app.get("/api/workspace/app-code/zip", authMiddleware, getWorkspaceAppCodeZip);
  app.post("/api/workspace/sites/:site_id/duplicate", authMiddleware, (req, res) => postSiteDuplicate(req, res));
  app.get("/api/workspace/files", authMiddleware, getWorkspaceFiles);
  app.post("/api/workspace/files", ...workspaceFilesUploadChain);
  app.delete("/api/workspace/files/:id", authMiddleware, deleteWorkspaceFileRoute);
  app.post("/api/workspace/email-lists/preview-csv", ...previewCsvChain);
  app.post("/api/workspace/email-lists/import-csv", ...importCsvChain);
  app.post("/api/workspace/email-lists/import-database", postImportDatabase);
  app.post("/api/workspace/email-lists/:id/versions/:vid/consent", postListConsent);
  app.get("/api/workspace/email-lists", getEmailLists);
  app.get("/api/workspace/email-lists/archived", getArchivedEmailLists);
  app.get("/api/workspace/email-lists/:id/contacts", getEmailListContacts);
  app.get("/api/workspace/email-contacts", getEmailContacts);
  app.delete("/api/workspace/email-lists/:id", deleteEmailList);
  app.post("/api/workspace/email-lists/:id/unarchive", postUnarchiveEmailList);
  app.delete("/api/workspace/email-contacts/:id", deleteEmailContact);
  app.get("/api/workspace/email-sends/:decisionId", getBulkSendProgress);
  app.get("/api/workspace/operator-db/tables", getImportTables);
  app.get("/api/workspace/operator-db/tables/:table/columns", getImportTableColumns);
  app.get("/api/workspace/sending-domain", getSendingDomainHandler);
  app.post("/api/workspace/sending-domain", addSendingDomainHandler);
  app.post("/api/workspace/sending-domain/verify", verifySendingDomainHandler);
  app.delete("/api/workspace/sending-domain", deleteSendingDomainHandler);
  app.get("/api/workspace/email-template", getEmailTemplateHandler);
  app.put("/api/workspace/email-template", putEmailTemplateHandler);
  app.post("/api/workspace/email-template/draft", draftEmailTemplateHandler);
  app.get("/api/workspace/sendgrid/senders", getSendgridSendersHandler);
  app.get("/api/workspace/sendgrid/suppression-groups", getSendgridSuppressionGroupsHandler);
  app.get("/api/workspace/sendgrid/lists", getSendgridListsHandler);
  app.get("/api/workspace/email-test-lists", getEmailTestListsHandler);
  app.post("/api/workspace/email-test-lists", postEmailTestListHandler);
  app.get("/api/workspace/email-suppressions", getEmailSuppressionsHandler);
  app.post("/api/workspace/email-suppressions", postEmailSuppressionHandler);
  app.get("/api/workspace/email-learnings", getEmailLearningsHandler);
  app.get("/api/workspace/email-learnings/removed", getRemovedEmailLearningsHandler);
  app.post("/api/workspace/email-learnings/seen", postEmailLearningsSeenHandler);
  app.post("/api/workspace/email-learnings/look-again", postEmailLearningsLookAgainHandler);
  app.post("/api/workspace/email-learnings", postEmailLearningHandler);
  app.get("/api/workspace/email-plan", getEmailPlanHandler);
  app.post("/api/workspace/email-plan", postEmailPlanHandler);
  app.post("/api/workspace/email-plan/:id/move", postEmailPlanMoveHandler);
  app.post("/api/workspace/email-plan/:id/angle", postEmailPlanAngleHandler);
  app.post("/api/workspace/email-plan/:id/skip", postEmailPlanSkipHandler);
  app.post("/api/workspace/email-plan/:id/draft-now", postEmailPlanDraftNowHandler);
  app.post("/api/workspace/email-plan/:id/schedule", postEmailPlanScheduleHandler);
  app.post("/api/workspace/email-plan/:id/withdraw", postEmailPlanWithdrawHandler);
  app.post("/api/workspace/email-plan/holds/:rail/:card_id/not-sent", postEmailPlanNotSentHandler);
  app.post("/api/email-cards/paste", postEmailPasteHandler);
  app.get("/api/email-cards/:rail/:id", getEmailCardHandler);
  app.get("/api/email-cards/:rail/:id/count", getEmailCardCountHandler);
  app.post("/api/email-cards/:rail/:id/test", postEmailCardTestHandler);
  app.post("/api/email-cards/:rail/:id/approve", postEmailCardApproveHandler);
  app.patch("/api/email-cards/:rail/:id/variants/:n", patchEmailCardVariantHandler);
  app.post("/api/email-cards/:rail/:id/stop", postEmailCardStopHandler);
  app.get("/api/workspace/email-pause", getEmailPauseHandler);
  app.post("/api/workspace/email-pause", postEmailPauseHandler);
  app.get("/api/email-results", getEmailResultsHandler);
  app.post("/api/workspace/file-collections", authMiddleware, postWorkspaceFileCollection);
  app.patch("/api/workspace/file-collections/:id", authMiddleware, patchWorkspaceFileCollection);
  app.delete("/api/workspace/file-collections/:id", authMiddleware, deleteWorkspaceFileCollection);
  app.post("/api/workspace/file-collections/:id/files", authMiddleware, postWorkspaceFileCollectionFiles);
  app.delete("/api/workspace/file-collections/:id/files/:fileId", authMiddleware, deleteWorkspaceFileCollectionFile);

  app.get("/api/playbooks", authMiddleware, getPlaybooks);
  app.post("/api/playbooks/:slug/launch", authMiddleware, launchPlaybook);
  app.get("/api/playbooks/runs/:id/trail", authMiddleware, getPlaybookTrail);

  app.get("/api/workspace/autopilot", authMiddleware, getAutopilot);
  app.get("/api/workspace/material-news-pref", authMiddleware, getMaterialNewsPref);
  app.post("/api/workspace/material-news-pref", authMiddleware, postMaterialNewsPref);
  app.get("/api/workspace/notification-prefs", authMiddleware, getNotificationPrefs);
  app.patch("/api/workspace/notification-prefs", authMiddleware, patchNotificationPrefs);
  app.get("/api/workspace/autopilot/runs", authMiddleware, getAutopilotRuns);
  app.get("/api/workspace/autopilot/runs/:id", authMiddleware, getAutopilotRunDetail);
  app.get("/api/workspace/autopilot/build-status", authMiddleware, getAutopilotBuildStatus);
  app.post("/api/workspace/autopilot/build-watch", authMiddleware, postBuildWatch);
  app.post("/api/workspace/autopilot/build-admin-link", authMiddleware, postAutopilotBuildAdminLink);
  app.get("/api/workspace/autopilot/build-sessions", authMiddleware, getAutopilotBuildSessions);
  app.get("/api/workspace/app-preview/readiness", authMiddleware, getAppPreviewReadinessHandler);
  app.get(
    "/api/workspace/engineer-preview/:runId/status",
    authMiddleware,
    getEngineerPreviewStatus,
  );
  app.get(
    "/api/workspace/engineer/html-preview/:previewId",
    authMiddleware,
    getEngineerHtmlPreviewArtifact,
  );
  app.post(
    "/api/workspace/engineer/html-preview/:previewId/displayed",
    authMiddleware,
    acknowledgeEngineerHtmlPreviewDisplayed,
  );
  app.post(
    "/api/workspace/engineer-preview/:runId/restart",
    authMiddleware,
    restartEngineerPreviewRoute,
  );
  app.all("/api/workspace/engineer-preview/:runId/*", engineerPreviewProxy);

  app.post(
    "/api/workspace/engineer/preview-session",
    authMiddleware,
    openEngineerSitePreview,
  );
  app.delete(
    "/api/workspace/engineer/preview-session/:sessionId",
    authMiddleware,
    closeEngineerSitePreview,
  );

  app.get("/api/public/prototype/:slug", publicPrototypePage);
  app.get("/api/workspace/prototype-link/:runId", getPrototypeLinkForRun);
  app.post("/api/workspace/prototype-link/:runId/revoke", revokePrototypeLink);
  app.get("/api/workspace/shared-pages", listSharedPages);
  app.get("/api/workspace/shared-pages/:id", getSharedPage);
  app.post("/api/workspace/shared-pages/:id/publish", publishSharedPage);
  app.post("/api/workspace/shared-pages/:id/revoke", revokeSharedPage);
  app.post("/api/workspace/reports/share", shareReport);
  app.get("/api/workspace/autopilot/refines", authMiddleware, getAutopilotRefines);
  app.post("/api/workspace/autopilot/settings", authMiddleware, postAutopilotSettings);
  app.get("/api/workspace/autopilot/waivers", authMiddleware, getAutopilotWaivers);
  app.post("/api/workspace/autopilot/waivers", authMiddleware, postAutopilotWaiver);
  app.delete("/api/workspace/autopilot/waivers/:decision_class", authMiddleware, deleteAutopilotWaiver);

  app.get("/api/workspace/autopilot/goals", authMiddleware, getAutopilotGoals);
  app.get("/api/workspace/autopilot/goals/current-value", authMiddleware, getAutopilotGoalCurrentValue);
  app.get("/api/workspace/autopilot/goals/:id/history", authMiddleware, getGoalHistory);
  app.post("/api/workspace/autopilot/goals", authMiddleware, postAutopilotGoals);
  app.patch("/api/workspace/autopilot/goals/:id", authMiddleware, patchAutopilotGoal);
  app.delete("/api/workspace/autopilot/goals/:id", authMiddleware, deleteAutopilotGoal);

  app.get("/api/workspace/stripe/payout-account", authMiddleware, getStripePayoutAccount);
  app.post("/api/workspace/stripe/payout-account", authMiddleware, postStripePayoutAccount);
  app.post("/api/workspace/stripe/onboarding-link", authMiddleware, postStripeOnboardingLink);
  app.post("/api/workspace/stripe/money-model", authMiddleware, postStripeMoneyModel);

  const tenantKey = (req: Request, fallbackPrefix: string): string => {
    const tid = req.auth?.tenant_id;
    if (tid) return "t:" + tid;
    return fallbackPrefix + (req.ip ?? "unknown");
  };

  const buildProductLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => tenantKey(req, "ip-build:"),
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "5 builds/min. Slow down" },
      }),
  });
  app.post(
    "/api/workspace/autopilot/build-product",
    authMiddleware,
    buildProductLimiter,
    postAutopilotBuildProduct,
  );
  app.post(
    "/api/workspace/website/rebuild-old-site",
    authMiddleware,
    buildProductLimiter,
    postRebuildOldSite,
  );
  const refineProductLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => tenantKey(req, "ip-refine:"),
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "10 refines/min. Slow down" },
      }),
  });
  app.post(
    "/api/workspace/autopilot/refine-product",
    authMiddleware,
    refineProductLimiter,
    postAutopilotRefineProduct,
  );
  app.post("/api/website/site-edits/apply", authMiddleware, refineProductLimiter, postApplySiteEdits);
  const siteDesignEditLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });
  app.get("/api/website/site-design-edit", authMiddleware, getSiteDesignEdit);
  app.get("/api/website/preview-snapshot", authMiddleware, getSitePreviewSnapshot);
  app.post("/api/website/site-design-edit", authMiddleware, siteDesignEditLimiter, postSiteDesignEdit);
  app.get("/api/website/site-comments", authMiddleware, listSiteComments);
  app.post("/api/website/site-comments", authMiddleware, siteCommentsMutationLimiter, createSiteComment);
  app.post("/api/website/site-comments/:id/replies", authMiddleware, siteCommentsMutationLimiter, replySiteComment);
  app.post("/api/website/site-comments/:id/status", authMiddleware, siteCommentsMutationLimiter, setSiteCommentStatus);

  const websiteChatDispatchLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    skip: (req: Request) => (req.body as { confirm?: unknown } | undefined)?.confirm !== true,
    keyGenerator: (req: Request) => tenantKey(req, "ip-refine:"),
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "10 app changes/min. Slow down" },
      }),
  });
  app.post(
    "/api/workspace/website/chat",
    authMiddleware,
    websiteChatDispatchLimiter,
    postWebsiteChat,
  );

  app.post(
    "/api/workspace/autopilot/refine-undo",
    authMiddleware,
    refineProductLimiter,
    postAutopilotRefineUndo,
  );
  app.post(
    "/api/workspace/autopilot/sites/:site_id/publish",
    authMiddleware,
    refineProductLimiter,
    postSitePublish,
  );
  app.post("/api/workspace/autopilot/sites/:site_id/looks-good", authMiddleware, postSiteSearchRelease);
  app.post("/api/workspace/autopilot/sites/:site_id/name", authMiddleware, postSiteRename);
  app.post(
    "/api/workspace/autopilot/restore-checkpoint",
    authMiddleware,
    refineProductLimiter,
    postAutopilotRestoreCheckpoint,
  );
  app.post(
    "/api/workspace/autopilot/version-preview",
    authMiddleware,
    refineProductLimiter,
    postAutopilotVersionPreview,
  );
  app.get(
    "/api/workspace/autopilot/version-preview",
    authMiddleware,
    getAutopilotVersionPreview,
  );
  app.get("/api/workspace/autopilot/live-edit", authMiddleware, getLiveEditState);
  app.post("/api/workspace/autopilot/live-edit/publish", authMiddleware, refineProductLimiter, postPublishDraft);
  app.post("/api/workspace/autopilot/live-edit/discard", authMiddleware, refineProductLimiter, postDiscardDraft);
  app.post("/api/workspace/autopilot/live-edit/wake", authMiddleware, refineProductLimiter, postWakeLiveEditPreview);
  app.post("/api/workspace/autopilot/build-preview/restart", authMiddleware, refineProductLimiter, postRestartBuildPreview);
  app.get("/api/workspace/autopilot/site-design", authMiddleware, getSiteDesign);
  app.post("/api/workspace/autopilot/site-design/direction", authMiddleware, refineProductLimiter, postSiteDesignDirection);

  app.get(
    "/api/workspace/autopilot/deploy-status",
    authMiddleware,
    getAutopilotDeployStatus,
  );
  app.get(
    "/api/workspace/autopilot/restore-status",
    authMiddleware,
    getAutopilotRestoreStatus,
  );

  app.post(
    "/api/workspace/autopilot/runs/:run_id/nodes/:node_id/undo",
    authMiddleware,
    postAutopilotUndoNode,
  );

  app.post(
    "/api/workspace/autopilot/runs/:run_id/cancel",
    authMiddleware,
    postAutopilotCancelRun,
  );
  app.post(
    "/api/workspace/autopilot/runs/:run_id/continue",
    authMiddleware,
    postAutopilotContinueRun,
  );

  app.get(
    "/api/workspace/autopilot/chips",
    authMiddleware,
    getAutopilotChips,
  );

  const planModeLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => tenantKey(req, "ip-plan:"),
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "10 plan requests/min. Slow down" },
      }),
  });

  app.post(
    "/api/workspace/autopilot/plan",
    authMiddleware,
    planModeLimiter,
    postAutopilotPlan,
  );

  app.post(
    "/api/workspace/autopilot/clarify-questions",
    authMiddleware,
    planModeLimiter,
    postAutopilotClarifyQuestions,
  );

  app.get("/api/home/summary", homeSummary);
  app.post("/api/home/goals", postHomeGoal);

  app.get("/api/analytics/what-moved", getWhatMoved);
  app.post("/api/analytics/anomaly-mutes", postAnomalyMute);

  app.post("/api/onboarding-emails/visit", postOnboardingEmailVisit);

  app.get("/api/public/live-feed", publicLiveFeed);

  const gatekeeperCheckLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => "gk:" + (req.ip ?? "unknown"),
  });
  app.get("/api/gatekeeper/check/:name", gatekeeperCheckLimiter, gatekeeperCheck);

  app.get("/api/public/pricing", publicPricing);
  app.get("/api/public/build-framing", publicBuildFraming);
  app.get("/api/public/site-templates", publicSiteTemplatesRoute);

  app.get("/api/public/live-stats", publicLiveStats);

  const siteWakeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => "site-wake:" + (req.ip ?? "unknown"),
  });
  app.post(SITE_WAKE_PATH, siteWakeLimiter, siteWake);

  app.get("/api/public/workspace-files/:tenantId/:fileId/:name", getPublicWorkspaceFile);

  const launchVideoGenerateLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Please slow down." },
      }),
  });
  app.post("/api/public/launch-video/generate", launchVideoGenerateLimiter, launchVideoPublicGenerate);
  app.post("/api/public/launch-video/status", launchVideoPublicStatus);
  app.get("/api/public/launch-video/config", launchVideoPublicConfig);
  app.post("/api/public/launch-video/prefill", launchVideoPublicPrefill);
  app.post("/api/public/launch-video/chat", launchVideoPublicChat);
  app.post("/api/launch-video/claim", launchVideoClaim);

  const startCardLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Please slow down." },
      }),
  });
  app.post("/api/public/start-card", startCardLimiter, startCardCreate);
  app.post("/api/public/start-card/queue", startCardLimiter, startCardQueue);
  app.post("/api/public/start-card/report", startCardLimiter, startCardReport);
  app.get("/api/public/start-card/config", startCardConfig);
  const affiliateClickLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
  app.post("/api/public/affiliate/click", affiliateClickLimiter, express.json({ limit: "1kb" }), postAffiliateClick);
  app.get("/api/public/start-card/queue/confirm", startCardQueueConfirm);
  app.get("/api/public/start-card/report/confirm", startCardReportConfirmPage);
  app.post(
    "/api/public/start-card/report/confirm",
    startCardLimiter,
    express.urlencoded({ extended: false, limit: "4kb" }),
    startCardReportConfirm,
  );
  app.get("/api/public/start-card/:public_id", startCardGet);
  const seedNoticeLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => res.status(429).type("text").send("Too many requests. Please try again in a minute."),
  });
  app.get("/api/public/seed-notice/unsubscribe", seedNoticeLimiter, seedNoticeUnsubscribePage);
  app.post(
    "/api/public/seed-notice/unsubscribe",
    seedNoticeLimiter,
    express.urlencoded({ extended: false, limit: "4kb" }),
    seedNoticeUnsubscribe,
  );

  const leaderboardLimiter = rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Please slow down." },
      }),
  });
  app.get("/api/public/leaderboard", leaderboardLimiter, leaderboardList);
  app.get("/api/public/leaderboard/rank/:public_id", leaderboardLimiter, leaderboardRank);

  app.get("/api/public/live", leaderboardLimiter, publicLivePill);
  app.get("/api/public/live/:slug", leaderboardLimiter, publicLiveUpcar);
  app.get("/api/public/live/:slug/review/:day", startCardLimiter, getLiveUpcarReview);
  app.post("/api/public/live/:slug/review/:day", startCardLimiter, postLiveUpcarReview);
  app.post("/api/ingest/upcar/hourly-counts", leaderboardLimiter, postUpcarHourlyCounts);

  app.get("/api/auth/bootstrap-status", authBootstrapStatus);

  app.get("/api/commands", commandsList);
  app.post("/api/commands", commandsUpsert);
  app.delete("/api/commands/:slug", commandsDelete);

  app.post("/api/team/discover", teamDiscover);
  app.get("/api/team/members", teamMembersList);
  app.get("/api/team/members/:id", teamMemberDetail);
  app.post("/api/team/members/:id/update", teamMemberUpdate);
  app.post("/api/team/members/merge", teamMembersMerge);

  const authEmail429 = (_req: Request, res: Response) =>
    res.status(429).json({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again in a few minutes.",
      },
    });
  const authEmailPerIpLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: authEmail429,
  });
  const authEmailPerEmailLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const email =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "?";
      return `auth-email:${email}`;
    },
    handler: authEmail429,
  });
  app.post("/api/auth/signup-location", authEmailPerIpLimiter, signupLocation);
  app.post(
    "/api/auth/email/send-otp",
    authEmailPerIpLimiter,
    authEmailPerEmailLimiter,
    authEmailSendOtp,
  );
  app.post(
    "/api/public/launch-video/send-magic-link",
    authEmailPerIpLimiter,
    launchVideoPublicSendMagicLink,
  );
  app.post(
    "/api/auth/email/send-reset",
    authEmailPerIpLimiter,
    authEmailPerEmailLimiter,
    authEmailSendReset,
  );

  app.post("/api/devices", devicesRegister);
  app.delete("/api/devices/:id", devicesDelete);
  app.get("/api/mobile/notification-settings", getNotificationSettings);
  app.patch("/api/mobile/notification-settings", patchNotificationSettings);

  const mobileConfigLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Please slow down." },
      }),
  });
  app.get("/api/mobile/config", mobileConfigLimiter, getMobileConfig);

  app.get("/api/notifications/agent-email-recipients", listAgentEmailRecipients);
  app.post("/api/notifications/agent-email-recipients", addAgentEmailRecipient);
  app.delete(
    "/api/notifications/agent-email-recipients/:id",
    removeAgentEmailRecipient,
  );

  app.get("/api/takes/scorecard", takesScorecard);

  app.post("/api/voice/session/start", voiceSessionStart);
  app.get("/internal/voice/health", voiceInternalHealth);
  app.post("/internal/voice/warmup", voiceInternalWarmup);
  app.post("/internal/voice/session/hydrate", voiceInternalSessionHydrate);
  app.post("/internal/voice/agent-turn", voiceInternalAgentTurn);
  app.post("/internal/voice/utterance/user", voiceInternalUtteranceUser);
  app.post("/internal/voice/cost/flush", voiceInternalCostFlush);
  app.post("/internal/voice/session/end", voiceInternalSessionEnd);
  app.post("/internal/voice/error", voiceInternalError);

  app.get("/internal/inflight-runs", internalInflightRuns);

  app.post("/internal/quiesce", internalQuiesce);

  app.post("/internal/unquiesce", internalUnquiesce);

  app.use("/api/internal/local-runs", localRunsRouter());

  app.use("/api/connector", connectorRouter());
}
