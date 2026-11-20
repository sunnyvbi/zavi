
export const UNAVAILABLE = "unavailable this run";

const REVENUE_TOOLS = new Set([
  "operator_db__query_recent_transactions",
  "operator_db__query_bookings_by_geo_category",
  "operator_db__query_active_supply_by_geo_category",
  "operator_db__query_funnel_by_geo_category",
  "stripe__list_payouts",
  "stripe__retrieve_payout",
  "stripe__list_charges",
  "stripe__retrieve_dispute",
]);

type ToolCall = {
  name?: string;
  tool_name?: string;
  output_preview?: string;
  output?: string;
  status?: string;
};

function toolName(tc: ToolCall): string {
  return tc.name ?? tc.tool_name ?? "";
}
function toolOutput(tc: ToolCall): string {
  return tc.output_preview ?? tc.output ?? "";
}

function toolReturnedRealData(tc: ToolCall): boolean {
  if (!REVENUE_TOOLS.has(toolName(tc))) return false;
  if (tc.status && tc.status !== "ok") return false;
  const raw = toolOutput(tc).toLowerCase();
  if (!raw) return false;
  if (raw.includes("_not_connected")) return false;
  if (raw.includes('"ready":false') || raw.includes('"ready": false')) return false;
  if (raw.includes('"ok":false') || raw.includes('"ok": false')) return false;
  return true;
}

export function revenueDataAvailable(toolCalls: ToolCall[] | undefined): boolean {
  return (toolCalls ?? []).some(toolReturnedRealData);
}

export function hasWiredRevenueConnector(resolvedToolNames?: string[]): boolean {
  return (resolvedToolNames ?? []).some((n) => REVENUE_TOOLS.has(n));
}

const MONEY_RX =
  /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:thousand|million|billion|trillion)s?\b|\s?[kKmMbB](?![A-Za-z]))?(?:\s?\/\s?(?:wk|week|mo|month|day|yr|year))?/g;

const REVENUE_KEY_RX = /gmv|gtv|revenue|liquidity|bookings_value|sales_volume/i;

const REVENUE_METRIC_LINE_RX =
  /^[\s>*_-]*\*\*[^*]*(?:gmv|gtv|revenue|liquidity)[^*]*:\*\*/i;

type DigestLike = {
  tier2?: Array<{ area?: string; summary?: string; metrics?: Record<string, unknown> }>;
  rendered_markdown?: string;
  [k: string]: unknown;
};

export function scrubUngroundedRevenue(digest: DigestLike): number {
  let subs = 0;

  for (const item of digest.tier2 ?? []) {
    const metrics = item.metrics;
    if (!metrics) continue;
    for (const [key, val] of Object.entries(metrics)) {
      if (typeof val !== "string") continue;
      const namesRevenue = REVENUE_KEY_RX.test(key) || REVENUE_KEY_RX.test(val);
      const hasMoney = MONEY_RX.test(val);
      MONEY_RX.lastIndex = 0;
      if (namesRevenue && hasMoney) {
        metrics[key] = UNAVAILABLE;
        subs += 1;
      }
    }
  }

  if (typeof digest.rendered_markdown === "string") {
    const lines = digest.rendered_markdown.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!REVENUE_METRIC_LINE_RX.test(line)) continue;
      if (!MONEY_RX.test(line)) {
        MONEY_RX.lastIndex = 0;
        continue;
      }
      MONEY_RX.lastIndex = 0;
      const rewritten = line.replace(MONEY_RX, UNAVAILABLE);
      MONEY_RX.lastIndex = 0;
      if (rewritten !== line) {
        lines[i] = rewritten;
        changed = true;
        subs += 1;
      }
    }
    if (changed) digest.rendered_markdown = lines.join("\n");
  }

  return subs;
}

const normalizeMoney = (s: string): string =>
  s.replace(/[$,\s]/g, "").toLowerCase();

export function scrubUngroundedRevenueProse(
  text: string,
  fedInContext: string,
): { text: string; subs: number } {
  if (!text) return { text, subs: 0 };
  const fedNorm = fedInContext ? normalizeMoney(fedInContext) : "";
  const lines = text.split("\n");
  let subs = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!REVENUE_KEY_RX.test(line)) continue;
    MONEY_RX.lastIndex = 0;
    if (!MONEY_RX.test(line)) {
      MONEY_RX.lastIndex = 0;
      continue;
    }
    MONEY_RX.lastIndex = 0;
    const rewritten = line.replace(MONEY_RX, (tok) => {
      if (fedNorm && fedNorm.includes(normalizeMoney(tok))) return tok;
      subs += 1;
      return UNAVAILABLE;
    });
    MONEY_RX.lastIndex = 0;
    if (rewritten !== line) lines[i] = rewritten;
  }
  return subs > 0 ? { text: lines.join("\n"), subs } : { text, subs: 0 };
}

export const __test = {
  toolReturnedRealData,
  REVENUE_TOOLS,
  REVENUE_METRIC_LINE_RX,
  UNAVAILABLE,
  normalizeMoney,
};
