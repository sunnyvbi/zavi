
import type { ToolEffect } from "@/services/tools/types";
import { toAnthropicName, type McpTool } from "./types";
import { ROUTINE_SERVER_ID } from "@/services/routines/tool-name";
import { listSlackTools } from "./internal/slack";
import { listGithubTools, listGithubHiddenWriteToolEffects } from "./internal/github";
import { listWebSearchTools } from "./internal/web-search";
import { listConnectorSearchTools } from "./internal/connectors-search";
import { listApifyTools } from "./internal/apify";
import { listWebFetchTools } from "./internal/web_fetch";
import { listProductProbeTools } from "./internal/product";
import { listBrowserTaskTools } from "./internal/browser-task";
import { listExtensionBrowserTaskTools } from "./internal/extension-browser-task";
import { listOperatorDbTools } from "./internal/operator-db";
import { listInvestorDbTools } from "./internal/investor-db";
import { listInvestorDiscoveryTools } from "./internal/investor-discovery";
import { listMemoryToolsForFlag } from "./internal/memory";
import { listBrainTools } from "./internal/brain";
import { listSocialTools } from "./internal/social";
import { listOutboundTools } from "./internal/outbound";
import { listGeneratedVideoTools } from "./internal/generated-video";
import { listCreatorTools } from "@/services/tools/creators/facade";
import { listSeoTools } from "./internal/seo";
import { listGeoTools } from "./internal/geo";
import { listOnboardingDiscoveryTools } from "./internal/onboarding-discovery";
import { listPraxisCorpusTools } from "./internal/praxis-corpus";
import { listMetaAdsTools } from "./internal/meta-ads";
import { listGoogleAdsTools } from "./internal/google-ads";
import { listTikTokTools } from "./internal/tiktok";
import { listPosthogTools } from "./internal/posthog";
import { listRedditAdsTools } from "./internal/reddit-ads";
import { listEmailCampaignTools } from "./internal/email-campaign";
import { listTikTokAdsTools } from "./internal/tiktok-ads";
import { listLinkedinAdsTools } from "./internal/linkedin-ads";
import { listSnapchatAdsTools } from "./internal/snapchat-ads";
import { listSpotifyAdsTools } from "./internal/spotify-ads";
import { listPinterestAdsTools } from "./internal/pinterest-ads";
import { listMicrosoftAdsTools } from "./internal/microsoft-ads";
import { listXAdsTools } from "./internal/x-ads";
import { listAppleAdsTools } from "./internal/apple-ads";
import { listSentryTools } from "./internal/sentry";
import { listFigmaTools } from "./internal/figma";
import { listGoogleSheetsTools } from "./internal/google-sheets";
import { listGoogleCalendarTools } from "./internal/google-calendar";
import { listSupabaseTools } from "./internal/supabase-connector";
import { listGoogleAnalyticsTools } from "./internal/google-analytics";
import { listGoogleSearchConsoleTools } from "./internal/google-search-console";
import { listBufferTools } from "./internal/buffer";
import { listGrowthTools } from "./internal/growth";
import { listPaidAcquisitionTools } from "./internal/paid-acquisition";
import { listChatgptAdsTools } from "./internal/chatgpt-ads";
import { listYoutubeTools } from "./internal/youtube";
import { listXSocialTools } from "./internal/x-social";
import { listInstagramTools } from "./internal/instagram";
import { listYoutubeInsightsTools } from "./internal/youtube-insights";
import { listPinterestInsightsTools } from "./internal/pinterest-insights";
import { listRedditTools } from "./internal/reddit";
import { listPinterestTools } from "./internal/pinterest";
import { listJiraTools, listJiraHiddenWriteToolEffects } from "./internal/jira";
import { listLinearTools, listLinearHiddenWriteToolEffects } from "./internal/linear";
import { listQaEngineerTools } from "./internal/qa-engineer";
import { listPraxisTools } from "./internal/praxis";
import { listStripeTools } from "./internal/stripe";
import { listEmailTools } from "./internal/email";
import { listSupportInboxTools } from "./internal/support-inbox";
import { listReportTools } from "./internal/report";
import { listArtifactsTools } from "./internal/artifacts";
import { listCodeIndexTools } from "./internal/code-index";

const CALLABLE_WITHOUT_A_LIST: ReadonlyArray<{ server_id: string; tool_name: string; effect: ToolEffect }> = [
  { server_id: "skill", tool_name: "load", effect: "read" },
  { server_id: "competitor_intel", tool_name: "http_fetch", effect: "read" },
];

export function allAdvertisableInternalTools(): McpTool[] {
  return [
    ...listSlackTools(),
    ...listGithubTools(),
    ...listWebSearchTools(),
    ...listConnectorSearchTools(),
    ...listApifyTools(),
    ...listWebFetchTools(),
    ...listProductProbeTools(),
    ...listBrowserTaskTools(),
    ...listExtensionBrowserTaskTools(),
    ...listOperatorDbTools(),
    ...listInvestorDbTools(),
    ...listInvestorDiscoveryTools(),
    ...listMemoryToolsForFlag(false),
    ...listMemoryToolsForFlag(true),
    ...listBrainTools(),
    ...listSocialTools(),
    ...listOutboundTools(),
    ...listGeneratedVideoTools(),
    ...listCreatorTools(),
    ...listSeoTools(),
    ...listGeoTools(),
    ...listOnboardingDiscoveryTools(),
    ...listPraxisCorpusTools(),
    ...listMetaAdsTools(),
    ...listGoogleAdsTools(),
    ...listTikTokTools(),
    ...listPosthogTools(),
    ...listRedditAdsTools(),
    ...listEmailCampaignTools(),
    ...listTikTokAdsTools(),
    ...listLinkedinAdsTools(),
    ...listSnapchatAdsTools(),
    ...listSpotifyAdsTools(),
    ...listPinterestAdsTools(),
    ...listMicrosoftAdsTools(),
    ...listXAdsTools(),
    ...listAppleAdsTools(),
    ...listSentryTools(),
    ...listFigmaTools(),
    ...listGoogleSheetsTools(),
    ...listGoogleCalendarTools(),
    ...listSupabaseTools(),
    ...listGoogleAnalyticsTools(),
    ...listGoogleSearchConsoleTools(),
    ...listBufferTools(),
    ...listGrowthTools(),
    ...listPaidAcquisitionTools(),
    ...listChatgptAdsTools(),
    ...listYoutubeTools(),
    ...listXSocialTools(),
    ...listInstagramTools(),
    ...listYoutubeInsightsTools(),
    ...listRedditTools(),
    ...listPinterestTools(),
    ...listPinterestInsightsTools(),
    ...listJiraTools(),
    ...listLinearTools(),
    ...listQaEngineerTools(),
    ...listPraxisTools(),
    ...listStripeTools(),
    ...listEmailTools(),
    ...listSupportInboxTools(),
    ...listReportTools(),
    ...listArtifactsTools(),
    ...listCodeIndexTools(),
  ];
}

export function hiddenInternalWriteTools(): Array<{ server_id: string; tool_name: string; effect: ToolEffect }> {
  return [
    ...listGithubHiddenWriteToolEffects().map((t) => ({ server_id: "github", ...t })),
    ...listJiraHiddenWriteToolEffects().map((t) => ({ server_id: "jira", ...t })),
    ...listLinearHiddenWriteToolEffects().map((t) => ({ server_id: "linear", ...t })),
  ];
}

export function internalToolEffects(): Map<string, ToolEffect> {
  const out = new Map<string, ToolEffect>();
  for (const t of allAdvertisableInternalTools()) {
    out.set(toAnthropicName(t.server_id, t.tool_name), t.effect ?? "write");
  }
  for (const t of [...hiddenInternalWriteTools(), ...CALLABLE_WITHOUT_A_LIST]) {
    out.set(toAnthropicName(t.server_id, t.tool_name), t.effect);
  }
  return out;
}

export const TENANT_ROUTINE_SERVER_ID = ROUTINE_SERVER_ID;

let CACHED_EFFECTS: Map<string, ToolEffect> | null = null;
function cachedInternalToolEffects(): Map<string, ToolEffect> {
  if (!CACHED_EFFECTS) CACHED_EFFECTS = internalToolEffects();
  return CACHED_EFFECTS;
}

export function effectOf(
  server_id: string,
  tool_name: string,
  effects: Map<string, ToolEffect> = cachedInternalToolEffects(),
): ToolEffect {
  if (server_id === TENANT_ROUTINE_SERVER_ID) return "write";
  return effects.get(toAnthropicName(server_id, tool_name)) ?? "write";
}
