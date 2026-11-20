
export const WRITE_VERB_RE =
  /(^|[_-])(create|update|delete|remove|insert|add|set|send|post|put|patch|write|edit|upload|publish|archive|cancel|approve|reject|merge|close|move|assign|invite|revoke|disable|enable|trigger|execute|run|start|stop|pay|charge|refund|transfer|mutation|mutate)([_-]|$)/i;

export function looksLikeWriteToolName(tool_name: string): boolean {
  return WRITE_VERB_RE.test(tool_name);
}

export const FETCH_VERB_RE =
  /(^|[_-])(fetch|http|https|request|browse|browser|scrape|scraper|crawl|crawler|download|curl|url|uri|web|www|rag|proxy|retrieve|readpage|read_url|read_page|apicall|api_call)([_-]|$)|(^|[_-])(get|read|search|lookup|query)([_-]|$)/i;

export function looksLikeFetchToolName(tool_name: string): boolean {
  return FETCH_VERB_RE.test(tool_name);
}

export function isDynamicVendorServerId(server_id: string): boolean {
  return server_id.startsWith("pipedream_") || server_id === "composio";
}

export const EGRESS_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "web_search__search",
  "web_fetch__fetch",
  "apify__rag_web_browser",
]);

const PUBLIC_WEB_TOOL_NAMES = EGRESS_TOOL_NAMES;

const INTERNAL_SERVER_IDS: ReadonlySet<string> = new Set<string>([
  "web_search",
  "web_fetch",
  "apify",
  "connectors",
  "memory",
  "brain",
  "operator_db",
  "investor_db",
  "investor_discovery",
  "onboarding_discovery",
  "posthog",
  "reddit_ads",
  "email_campaign",
  "chatgpt_ads",
  "tiktok_ads",
  "linkedin_ads",
  "snapchat_ads",
  "spotify_ads",
  "pinterest_ads",
  "microsoft_ads",
  "x_ads",
  "apple_ads",
  "x_social",
  "instagram",
  "youtube_insights",
  "pinterest_insights",
  "sentry",
  "figma",
  "google_sheets",
  "google_calendar",
  "supabase",
  "praxis",
  "praxis_corpus",
  "product",
  "qa_engineer",
  "growth",
  "email",
  "support_inbox",
  "report",
  "artifacts",
  "code_index",
  "stripe",
  "github",
  "slack",
  "jira",
  "linear",
  "meta_ads",
  "google_ads",
  "google_drive",
  "teams",
  "paid_acquisition",
  "buffer",
  "social_card",
]);

const METER_HINT_RE =
  /(^|[_-])(generate|synthesi[sz]e|render|upscale|outpaint|reframe|animat\w*|dub\w*|clip|tts|voice|explainer|shorts?)([_-]|$)|create_(image|video|audio|3d)/i;

const REVENUE_VERB_RE =
  /(^|[_-])(pay|payment|charge|refund|payout|remit|transfer|invoice|checkout|subscribe|subscription|billing|capture)([_-]|$)/i;

export type Cap = "yes" | "no" | "unknown";

export type ToolCapability = {
  write: Cap;
  egress: Cap;
  fetch: Cap;
  metered: Cap;
  revenue: Cap;
  privateData: Cap;
};

export type DeriveToolCapabilityArgs = {
  server_id: string;
  tool_name: string;
  annotations?: Record<string, unknown>;
  source?: string;
};

function annBool(
  annotations: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const v = annotations?.[key];
  return typeof v === "boolean" ? v : undefined;
}

export function deriveToolCapability(args: DeriveToolCapabilityArgs): ToolCapability {
  const { server_id, tool_name, annotations, source } = args;
  const anthropicName = `${server_id}__${tool_name}`;

  const dynamic = isDynamicVendorServerId(server_id);
  const internal =
    !dynamic && (INTERNAL_SERVER_IDS.has(server_id) || source === "internal" || source === "first_party");
  const writeVerb = looksLikeWriteToolName(tool_name);
  const readOnlyHint = annBool(annotations, "readOnlyHint");
  const destructiveHint = annBool(annotations, "destructiveHint");
  const openWorldHint = annBool(annotations, "openWorldHint");
  const isPublicWeb = PUBLIC_WEB_TOOL_NAMES.has(anthropicName);

  let write: Cap;
  if (writeVerb) write = "yes";
  else if (destructiveHint === true) write = "yes";
  else if (dynamic) write = "unknown";
  else if (readOnlyHint === true) write = "no";
  else if (internal) write = "no";
  else if (readOnlyHint === false) write = "yes";
  else write = "unknown";

  let egress: Cap;
  if (EGRESS_TOOL_NAMES.has(anthropicName)) egress = "yes";
  else if (openWorldHint === true) egress = "yes";
  else if (dynamic) egress = "yes";
  else if (internal) egress = "no";
  else if (openWorldHint === false) egress = "no";
  else egress = "unknown";

  let fetch: Cap;
  if (EGRESS_TOOL_NAMES.has(anthropicName)) fetch = "yes";
  else if (dynamic) fetch = "yes";
  else if (openWorldHint === true) fetch = "yes";
  else if (internal) fetch = "no";
  else if (openWorldHint === false) fetch = "no";
  else fetch = "unknown";

  let metered: Cap;
  if (METER_HINT_RE.test(tool_name)) metered = "yes";
  else if (dynamic) metered = "unknown";
  else if (internal) metered = "no";
  else metered = "unknown";

  let revenue: Cap;
  if (REVENUE_VERB_RE.test(tool_name)) revenue = "yes";
  else if (dynamic) revenue = "unknown";
  else if (internal) revenue = "no";
  else revenue = "unknown";

  let privateData: Cap;
  if (isPublicWeb) privateData = "no";
  else if (dynamic) privateData = "yes";
  else if (internal) privateData = "yes";
  else privateData = "unknown";

  return { write, egress, fetch, metered, revenue, privateData };
}

export function isEgressCapability(args: DeriveToolCapabilityArgs): boolean {
  const cap = deriveToolCapability(args);
  if (cap.egress === "yes") return true;
  if (cap.egress === "no") return false;
  return cap.fetch === "yes" || looksLikeFetchToolName(args.tool_name);
}

export function isEgressToolName(anthropic_name: string): boolean {
  const n = anthropic_name.startsWith("mcp__")
    ? anthropic_name.slice("mcp__".length)
    : anthropic_name;
  const sep = n.indexOf("__");
  const server_id = sep === -1 ? "" : n.slice(0, sep);
  const tool_name = sep === -1 ? n : n.slice(sep + 2);
  return isEgressCapability({ server_id, tool_name });
}
