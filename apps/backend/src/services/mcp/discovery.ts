
import { serviceClient } from "@/services/supabase";
import { isOutsidePaidChannelTool } from "@/services/agents/paid-channel-scope";
import { isHiddenFromAgent } from "@/services/agents/agent-tool-hide";
import { listSlackTools } from "./internal/slack";
import { listGithubTools } from "./internal/github";
import { listWebSearchTools } from "./internal/web-search";
import { listConnectorSearchTools } from "./internal/connectors-search";
import { isConnectorRequestEnabled } from "@/services/agents/_chat-degrade-flag-check";
import { listApifyTools } from "./internal/apify";
import { listWebFetchTools } from "./internal/web_fetch";
import { listProductProbeTools } from "./internal/product";
import { listBrowserTaskTools } from "./internal/browser-task";
import {
  listExtensionBrowserTaskTools,
  EXTENSION_TASK_SERVER_ID,
  EXTENSION_TASK_ANTHROPIC_NAME,
  isExtensionTaskAgent,
} from "./internal/extension-browser-task";
import { listOperatorDbTools } from "./internal/operator-db";
import { listInvestorDbTools } from "./internal/investor-db";
import { listInvestorDiscoveryTools } from "./internal/investor-discovery";
import { listMemoryTools } from "./internal/memory";
import { isAgenticReadEnabledForTenant } from "@/services/tools/memory/agentic-read";
import { listBrainTools } from "./internal/brain";
import { listSocialTools } from "./internal/social";
import { listOutboundTools } from "./internal/outbound";
import { listGeneratedVideoTools } from "./internal/generated-video";
import { CREATOR_SERVER_ID, listCreatorTools } from "@/services/tools/creators/facade";
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
import { listJiraTools } from "./internal/jira";
import { listLinearTools } from "./internal/linear";
import { listQaEngineerTools } from "./internal/qa-engineer";
import { listPraxisTools } from "./internal/praxis";
import { listStripeTools } from "./internal/stripe";
import { listEmailTools } from "./internal/email";
import { listSupportInboxTools } from "./internal/support-inbox";
import { listReportTools } from "./internal/report";
import { listArtifactsTools } from "./internal/artifacts";
import { listCodeIndexTools } from "./internal/code-index";
import { listStreamableTools, rememberAdvertisedTools } from "./streamable-client";
import { composioRailSlugs } from "@/services/connectors/composio/native-map";
import { isPipedreamServerId, isValidPipedreamServerId } from "@/services/connectors/pipedream/slug";
import {
  effectiveDeclaredTools,
  isReadBaselineTool,
  withMessagingBaseline,
  isMessagingBaselineTool,
  withUniversalBaseline,
  isUniversalBaselineTool,
} from "./write-allowlist";
import { fromAnthropicName, toAnthropicName, MCP_NAME_SEPARATOR, type AnthropicMcpTool, type McpServerRow, type McpTool } from "./types";
import { synthesizeApprovedRoutineTools } from "@/services/routines/inject";
import {
  agentHasSkills,
  synthesizeSkillLoadTool,
} from "@/services/agents/skill-runtime";
import { logEvent } from "@/services/logging/logEvent";
import { parseDeclaredToolMatchers, toolMatchesDeclared } from "./declared-tool-match";

const STREAMABLE_FANOUT_CONCURRENCY = 6;

const TOOL_CACHE = new Map<string, McpTool[]>();

export async function getEnabledStreamableServer(
  tenant_id: string,
  server_id: string,
): Promise<McpServerRow | null> {
  const { data, error } = await serviceClient()
    .from("tenant_mcp_servers")
    .select("tenant_id, server_id, transport, url, command, args, enabled")
    .eq("tenant_id", tenant_id)
    .eq("server_id", server_id)
    .eq("enabled", true)
    .eq("transport", "streamable-http")
    .maybeSingle();
  if (error || !data) return null;
  const row = data as McpServerRow;
  if (isPipedreamServerId(row.server_id) && !isValidPipedreamServerId(row.server_id)) {
    console.warn(`[mcp/discovery] rejecting invalid pipedream server_id: ${row.server_id}`);
    return null;
  }
  if (isPipedreamServerId(row.server_id)) return null;
  return row;
}

const PLATFORM_INTERNAL_SERVERS: McpServerRow[] = [
  { tenant_id: "*", server_id: "web_search", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "connectors", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "apify", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "memory", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "brain", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "operator_db", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "investor_db", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "investor_discovery", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "web_fetch", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "youtube", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "instagram", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "youtube_insights", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "tiktok_ads", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "reddit_ads", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "email_campaign", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "reddit", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "pinterest", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "pinterest_insights", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "product", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "browser", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "extension", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "onboarding_discovery", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "praxis_corpus", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "praxis", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "qa_engineer", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "growth", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "paid_acquisition", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "chatgpt_ads", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "email", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "support_inbox", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "report", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "social", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "outbound", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "generated_video", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: CREATOR_SERVER_ID, transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "seo", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "geo", transport: "internal", url: null, command: null, args: null, enabled: true },
  { tenant_id: "*", server_id: "artifacts", transport: "internal", url: null, command: null, args: null, enabled: true },
];

const CODE_INDEX_SERVER: McpServerRow = {
  tenant_id: "*",
  server_id: "code_index",
  transport: "internal",
  url: null,
  command: null,
  args: null,
  enabled: true,
};

function isCodeIndexEnabled(): boolean {
  return process.env.CODE_SYMBOL_INDEX_ENABLED !== "0";
}

function platformInternalServers(): McpServerRow[] {
  return isCodeIndexEnabled()
    ? [...PLATFORM_INTERNAL_SERVERS, CODE_INDEX_SERVER]
    : PLATFORM_INTERNAL_SERVERS;
}

const PLATFORM_INTERNAL_SERVER_IDS = new Set([
  ...PLATFORM_INTERNAL_SERVERS.map((s) => s.server_id),
  CODE_INDEX_SERVER.server_id,
]);

const COMPOSIO_BASELINE = `composio${MCP_NAME_SEPARATOR}*`;

async function listToolsForServer(server: McpServerRow): Promise<McpTool[]> {
  if (server.transport === "internal" && server.server_id === "memory") {
    const enabled = await isAgenticReadEnabledForTenant(server.tenant_id);
    const memCacheKey = `${server.tenant_id}:memory:${enabled ? 1 : 0}`;
    const memCached = TOOL_CACHE.get(memCacheKey);
    if (memCached) return memCached;
    const memTools = await listMemoryTools(server.tenant_id);
    TOOL_CACHE.set(memCacheKey, memTools);
    return memTools;
  }
  if (server.transport === "internal" && server.server_id === "connectors") {
    const enabled = await isConnectorRequestEnabled();
    const key = `connectors:${enabled ? 1 : 0}`;
    const hit = TOOL_CACHE.get(key);
    if (hit) return hit;
    const list = listConnectorSearchTools().filter((t) => enabled || t.tool_name !== "request");
    TOOL_CACHE.set(key, list);
    return list;
  }
  let composioToolkits: string[] | null = null;
  if (server.transport === "streamable-http" && server.server_id === "composio") {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", server.tenant_id)
      .like("slug", "composio.%");
    if (error) {
      void logEvent({
        level: "error",
        source: "mcp.discovery",
        code: "composio_connected_read_failed",
        tenant_id: server.tenant_id,
      }).catch(() => {});
      rememberAdvertisedTools(server.tenant_id, "composio", []);
      return [];
    }
    composioToolkits = composioRailSlugs(((data ?? []) as { slug: string }[]).map((r) => r.slug));
  }
  const cacheKey =
    server.transport === "streamable-http"
      ? `${server.tenant_id}:${server.server_id}${composioToolkits ? `:${composioToolkits.join(",")}` : ""}`
      : server.server_id;
  const cached = TOOL_CACHE.get(cacheKey);
  if (cached) {
    if (server.transport === "streamable-http") rememberAdvertisedTools(server.tenant_id, server.server_id, cached);
    return cached;
  }

  let tools: McpTool[] = [];
  if (server.transport === "internal") {
    if (server.server_id === "slack") {
      tools = listSlackTools();
    } else if (server.server_id === "github") {
      tools = listGithubTools();
    } else if (server.server_id === "web_search") {
      tools = listWebSearchTools();
    } else if (server.server_id === "connectors") {
      tools = listConnectorSearchTools();
    } else if (server.server_id === "apify") {
      tools = listApifyTools();
    } else if (server.server_id === "web_fetch") {
      tools = listWebFetchTools();
    } else if (server.server_id === "product") {
      tools = listProductProbeTools();
    } else if (server.server_id === "browser") {
      tools = listBrowserTaskTools();
    } else if (server.server_id === "extension") {
      tools = listExtensionBrowserTaskTools();
    } else if (server.server_id === "operator_db") {
      tools = listOperatorDbTools();
    } else if (server.server_id === "investor_db") {
      tools = listInvestorDbTools();
    } else if (server.server_id === "investor_discovery") {
      tools = listInvestorDiscoveryTools();
    } else if (server.server_id === "memory") {
      tools = await listMemoryTools(server.tenant_id);
    } else if (server.server_id === "brain") {
      tools = listBrainTools();
    } else if (server.server_id === "onboarding_discovery") {
      tools = listOnboardingDiscoveryTools();
    } else if (server.server_id === "praxis_corpus") {
      tools = listPraxisCorpusTools();
    } else if (server.server_id === "meta_ads") {
      tools = listMetaAdsTools();
    } else if (server.server_id === "google_ads") {
      tools = listGoogleAdsTools();
    } else if (server.server_id === "tiktok") {
      tools = listTikTokTools();
    } else if (server.server_id === "google_analytics") {
      tools = listGoogleAnalyticsTools();
    } else if (server.server_id === "google_search_console") {
      tools = listGoogleSearchConsoleTools();
    } else if (server.server_id === "posthog") {
      tools = listPosthogTools();
    } else if (server.server_id === "reddit_ads") {
      tools = listRedditAdsTools();
    } else if (server.server_id === "email_campaign") {
      tools = listEmailCampaignTools();
    } else if (server.server_id === "tiktok_ads") {
      tools = listTikTokAdsTools();
    } else if (server.server_id === "linkedin_ads") {
      tools = listLinkedinAdsTools();
    } else if (server.server_id === "snapchat_ads") {
      tools = listSnapchatAdsTools();
    } else if (server.server_id === "spotify_ads") {
      tools = listSpotifyAdsTools();
    } else if (server.server_id === "pinterest_ads") {
      tools = listPinterestAdsTools();
    } else if (server.server_id === "microsoft_ads") {
      tools = listMicrosoftAdsTools();
    } else if (server.server_id === "x_ads") {
      tools = listXAdsTools();
    } else if (server.server_id === "apple_ads") {
      tools = listAppleAdsTools();
    } else if (server.server_id === "sentry") {
      tools = listSentryTools();
    } else if (server.server_id === "figma") {
      tools = listFigmaTools();
    } else if (server.server_id === "google_sheets") {
      tools = listGoogleSheetsTools();
    } else if (server.server_id === "google_calendar") {
      tools = listGoogleCalendarTools();
    } else if (server.server_id === "supabase") {
      tools = listSupabaseTools();
    } else if (server.server_id === "buffer") {
      tools = listBufferTools();
    } else if (server.server_id === "growth") {
      tools = listGrowthTools();
    } else if (server.server_id === "paid_acquisition") {
      tools = listPaidAcquisitionTools();
    } else if (server.server_id === "chatgpt_ads") {
      tools = listChatgptAdsTools();
    } else if (server.server_id === "youtube") {
      tools = listYoutubeTools();
    } else if (server.server_id === "instagram") {
      tools = listInstagramTools();
    } else if (server.server_id === "youtube_insights") {
      tools = listYoutubeInsightsTools();
    } else if (server.server_id === "x_social") {
      tools = listXSocialTools();
    } else if (server.server_id === "reddit") {
      tools = listRedditTools();
    } else if (server.server_id === "pinterest") {
      tools = listPinterestTools();
    } else if (server.server_id === "pinterest_insights") {
      tools = listPinterestInsightsTools();
    } else if (server.server_id === "jira") {
      tools = listJiraTools();
    } else if (server.server_id === "linear") {
      tools = listLinearTools();
    } else if (server.server_id === "qa_engineer") {
      tools = listQaEngineerTools();
    } else if (server.server_id === "praxis") {
      tools = listPraxisTools();
    } else if (server.server_id === "stripe") {
      tools = listStripeTools();
    } else if (server.server_id === "email") {
      tools = listEmailTools();
    } else if (server.server_id === "support_inbox") {
      tools = listSupportInboxTools();
    } else if (server.server_id === "report") {
      tools = listReportTools();
    } else if (server.server_id === "social") {
      tools = listSocialTools();
    } else if (server.server_id === "outbound") {
      tools = listOutboundTools();
    } else if (server.server_id === "generated_video") {
      tools = listGeneratedVideoTools();
    } else if (server.server_id === CREATOR_SERVER_ID) {
      tools = listCreatorTools();
    } else if (server.server_id === "seo") {
      tools = listSeoTools();
    } else if (server.server_id === "geo") {
      tools = listGeoTools();
    } else if (server.server_id === "artifacts") {
      tools = listArtifactsTools();
    } else if (server.server_id === "code_index") {
      tools = listCodeIndexTools();
    } else {
      console.warn(`[mcp/discovery] no internal handler for server_id=${server.server_id}`);
    }
  } else if (server.transport === "streamable-http") {
    try {
      tools = await listStreamableTools(
        server.tenant_id,
        server,
        composioToolkits ? { toolkits: composioToolkits } : {},
      );
    } catch (e) {
      console.warn(
        `[mcp/discovery] streamable-http ${server.server_id} failed, degrading to no tools: ${(e as Error).message}`,
      );
      tools = [];
    }
  } else if (server.transport === "stdio") {
    console.warn(`[mcp/discovery] stdio transport for ${server.server_id} not yet wired`);
  }
  TOOL_CACHE.set(cacheKey, tools);
  return tools;
}

export type ResolvedTool = AnthropicMcpTool & {
  server_id: string;
  tool_name: string;
};

export type ToolDiscoveryResult = {
  tools: ResolvedTool[];
  disconnected_connectors: string[];
};

export async function discoverToolsForTenant(
  tenant_id: string,
  declared_tools: string[],
  agent_slug?: string,
  opts?: { suppressSkillTool?: boolean },
): Promise<ToolDiscoveryResult> {
  const effectiveDeclared = effectiveDeclaredTools(declared_tools);
  if (effectiveDeclared.length === 0) {
    return { tools: [], disconnected_connectors: [] };
  }

  const { data: servers, error } = await serviceClient()
    .from("tenant_mcp_servers")
    .select("tenant_id, server_id, transport, url, command, args, enabled")
    .eq("tenant_id", tenant_id)
    .eq("enabled", true);
  if (error) {
    throw new Error(`tenant_mcp_servers read failed: ${error.message}`);
  }

  const allServers: McpServerRow[] = [
    ...platformInternalServers().map((s) => ({ ...s, tenant_id })),
    ...(((servers ?? []) as McpServerRow[]).filter(
      (s) => !PLATFORM_INTERNAL_SERVER_IDS.has(s.server_id) && !isPipedreamServerId(s.server_id),
    )),
  ];

  const slackConnected = allServers.some((s) => s.server_id === "slack");
  const composioBaselined =
    allServers.some((s) => s.server_id === "composio") &&
    !effectiveDeclared.includes(COMPOSIO_BASELINE);
  const extensionTaskAgent = isExtensionTaskAgent(agent_slug);
  const effectiveWithMessaging = [
    ...withMessagingBaseline(withUniversalBaseline(effectiveDeclared), slackConnected),
    ...(composioBaselined ? [COMPOSIO_BASELINE] : []),
    ...(extensionTaskAgent ? [EXTENSION_TASK_ANTHROPIC_NAME] : []),
  ];

  const declared = new Set(effectiveWithMessaging);
  const WILDCARD_SUFFIX = `${MCP_NAME_SEPARATOR}*`;
  const PREFIX_WILDCARD_RE = /^(.+?)\*__\*$/;
  const wildcardServers = new Set<string>();
  const prefixWildcards = new Set<string>();
  const explicitServerIds = new Set<string>();
  for (const d of declared) {
    const pfx = d.match(PREFIX_WILDCARD_RE);
    if (pfx) {
      prefixWildcards.add(pfx[1]);
      continue;
    }
    if (d.endsWith(WILDCARD_SUFFIX)) {
      wildcardServers.add(d.slice(0, -WILDCARD_SUFFIX.length));
      continue;
    }
    const parts = fromAnthropicName(d);
    if (parts) explicitServerIds.add(parts.server_id);
  }
  const matchesPrefix = (sid: string) => {
    for (const p of prefixWildcards) if (sid.startsWith(p)) return true;
    return false;
  };
  const allAgentsAllTools = process.env.ALL_AGENTS_ALL_TOOLS !== "0";

  const serverWanted = (sid: string) =>
    allAgentsAllTools ||
    wildcardServers.has(sid) || explicitServerIds.has(sid) || matchesPrefix(sid);

  const allTools: McpTool[] = [];
  const remoteWanted: McpServerRow[] = [];
  for (const s of allServers) {
    if (s.transport === "streamable-http") {
      if (serverWanted(s.server_id)) remoteWanted.push(s);
    } else {
      allTools.push(...(await listToolsForServer(s)));
    }
  }
  for (let i = 0; i < remoteWanted.length; i += STREAMABLE_FANOUT_CONCURRENCY) {
    const batch = remoteWanted.slice(i, i + STREAMABLE_FANOUT_CONCURRENCY);
    const lists = await Promise.all(batch.map((s) => listToolsForServer(s)));
    for (const l of lists) allTools.push(...l);
  }

  const declaredMatchers = parseDeclaredToolMatchers(effectiveWithMessaging);
  const resolved: ResolvedTool[] = [];
  const seen = new Set<string>();
  const matchedWildcardServers = new Set<string>();
  for (const t of allTools) {
    const anthropic_name = toAnthropicName(t.server_id, t.tool_name);
    if (isOutsidePaidChannelTool(agent_slug, t.server_id, t.tool_name)) continue;
    if (isHiddenFromAgent(agent_slug, anthropic_name)) continue;
    if (t.server_id === EXTENSION_TASK_SERVER_ID && !extensionTaskAgent) continue;
    if (!allAgentsAllTools && !toolMatchesDeclared(anthropic_name, declaredMatchers))
      continue;
    if (seen.has(anthropic_name)) continue;
    seen.add(anthropic_name);
    if (wildcardServers.has(t.server_id) || matchesPrefix(t.server_id))
      matchedWildcardServers.add(t.server_id);
    resolved.push({
      name: anthropic_name,
      description: t.description,
      input_schema: t.input_schema,
      server_id: t.server_id,
      tool_name: t.tool_name,
    });
  }

  const disconnectedSet = new Set<string>();
  for (const declaredName of declared) {
    if (seen.has(declaredName)) continue;
    if (isReadBaselineTool(declaredName)) continue;
    if (isMessagingBaselineTool(declaredName)) continue;
    if (isUniversalBaselineTool(declaredName)) continue;
    if (composioBaselined && declaredName === COMPOSIO_BASELINE) continue;
    if (PREFIX_WILDCARD_RE.test(declaredName)) continue;
    const parts = fromAnthropicName(declaredName);
    const sid = parts?.server_id;
    if (parts?.tool_name === "*" && sid && matchedWildcardServers.has(sid)) continue;
    if (sid && !PLATFORM_INTERNAL_SERVER_IDS.has(sid)) {
      disconnectedSet.add(sid);
    }
    console.warn(
      `[mcp/discovery] agent declared tool "${declaredName}" but no enabled server provides it ` +
        `(parsed as server_id=${sid ?? "?"}, tool=${parts?.tool_name ?? "?"})`,
    );
  }

  if (agent_slug) {
    try {
      const skillTools = await synthesizeApprovedRoutineTools(tenant_id, agent_slug);
      for (const st of skillTools) {
        if (seen.has(st.name)) continue;
        seen.add(st.name);
        resolved.push(st);
      }
    } catch (e) {
      logEvent({
        level: "warn",
        source: "mcp.discovery",
        code: "tenant_skill_inject_failed",
        error: e,
        tenant_id,
        meta: { agent_slug },
      }).catch((logErr) =>
        console.error("tenant_skill_inject_log_failed", logErr),
      );
      console.warn(
        `[mcp/discovery] tenant-routine injection failed for tenant=${tenant_id} agent=${agent_slug}: ${(e as Error).message}`,
      );
    }
  }

  if (agent_slug && agentHasSkills(agent_slug) && opts?.suppressSkillTool !== true) {
    const skillTool = synthesizeSkillLoadTool();
    if (!seen.has(skillTool.name)) {
      seen.add(skillTool.name);
      resolved.push(skillTool);
    }
  }

  return {
    tools: resolved,
    disconnected_connectors: Array.from(disconnectedSet).sort(),
  };
}

export async function listToolsForTenant(
  tenant_id: string,
  declared_tools: string[],
  agent_slug?: string,
  opts?: { suppressSkillTool?: boolean },
): Promise<ResolvedTool[]> {
  const r = await discoverToolsForTenant(tenant_id, declared_tools, agent_slug, opts);
  return r.tools;
}

export function _clearToolCacheForTests(): void {
  TOOL_CACHE.clear();
}
