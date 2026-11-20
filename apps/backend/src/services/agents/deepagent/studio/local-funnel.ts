
import type { EngineToolCall, EngineToolResult, EngineToolSpec } from "../../engine/types";

const OBJ = { type: "object", properties: {}, additionalProperties: true } as const;

export const STUDIO_TOOLS: EngineToolSpec[] = [
  {
    name: "meta_ads__list_campaigns",
    description: "List Meta campaigns with status, daily budget and today's spend.",
    jsonSchema: OBJ,
  },
  {
    name: "meta_ads__daily_series",
    description:
      "Daily time series for a campaign: impressions, clicks, spend, conversions. " +
      "Args: {campaign_id, days}.",
    jsonSchema: OBJ,
  },
  {
    name: "operator_db__query",
    description:
      "Read-only SQL against the marketplace backend. Use for bookings and completed rentals. " +
      "Args: {sql}.",
    jsonSchema: OBJ,
  },
  {
    name: "memory__search",
    description: "Search the company brain. Args: {query, k}.",
    jsonSchema: OBJ,
  },
  {
    name: "slack__post_message",
    description: "Post a message to a Slack channel. Args: {channel, text}.",
    jsonSchema: OBJ,
  },
];

const FIXTURES: Record<string, unknown> = {
  meta_ads__list_campaigns: {
    campaigns: [
      { id: "23851", name: "Austin — Weekend Rentals", status: "ACTIVE", daily_budget_usd: 120, spend_today_usd: 118.4, delivery: "ok" },
      { id: "23852", name: "Austin — Retargeting", status: "ACTIVE", daily_budget_usd: 40, spend_today_usd: 39.1, delivery: "learning_limited" },
      { id: "23853", name: "Dallas — Prospecting", status: "PAUSED", daily_budget_usd: 80, spend_today_usd: 0, delivery: "paused" },
    ],
    account_timezone: "America/Chicago",
    as_of: "fixture",
  },
  meta_ads__daily_series: {
    campaign_id: "23851",
    timezone: "America/Chicago",
    days: [
      { date: "D-6", impressions: 41200, clicks: 921, spend_usd: 119.2, meta_conversions: 22 },
      { date: "D-5", impressions: 40850, clicks: 903, spend_usd: 118.7, meta_conversions: 21 },
      { date: "D-4", impressions: 42010, clicks: 940, spend_usd: 120.1, meta_conversions: 19 },
      { date: "D-3", impressions: 41770, clicks: 897, spend_usd: 119.5, meta_conversions: 15 },
      { date: "D-2", impressions: 43120, clicks: 951, spend_usd: 120.0, meta_conversions: 14 },
      { date: "D-1", impressions: 42660, clicks: 933, spend_usd: 118.4, meta_conversions: 12 },
    ],
    note: "fixture data — not a real account",
  },
  operator_db__query: {
    rows: [
      { date: "D-6", bookings: 18, completed_rentals: 16, cancellations: 2 },
      { date: "D-5", bookings: 17, completed_rentals: 15, cancellations: 2 },
      { date: "D-4", bookings: 16, completed_rentals: 12, cancellations: 4 },
      { date: "D-3", bookings: 13, completed_rentals: 9, cancellations: 4 },
      { date: "D-2", bookings: 12, completed_rentals: 7, cancellations: 5 },
      { date: "D-1", bookings: 11, completed_rentals: 5, cancellations: 6 },
    ],
    timezone: "UTC",
    freshness_minutes: 35,
    note: "fixture data — timezone deliberately differs from the ad account",
  },
  memory__search: {
    hits: [
      {
        slug: "company",
        text: "Upcar is a peer-to-peer car rental marketplace. The Q3 goal is 400 completed rentals/month. Optimize on completed rentals, never bookings.",
      },
      {
        slug: "ops",
        text: "Austin fleet capacity is ~14 concurrent rentals. Above that, cancellations rise sharply because owners decline.",
      },
    ],
  },
};

export type StudioToolLog = {
  tool: string;
  denied: boolean;
  ms: number;
};

function varyByArgs(toolName: string, input: unknown, fixture: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;

  if (toolName === "meta_ads__daily_series") {
    const requested = String(
      args.campaign_id ?? args.campaignId ?? args.campaign ?? args.id ?? "23851",
    );
    const base = fixture as {
      campaign_id: string;
      timezone: string;
      days: Array<Record<string, number | string>>;
    };
    if (requested === base.campaign_id) return fixture;
    if (requested === "23852") {
      return {
        ...base,
        campaign_id: requested,
        days: base.days.map((d) => ({
          ...d,
          impressions: Math.round(Number(d.impressions) * 0.18),
          clicks: Math.round(Number(d.clicks) * 0.31),
          spend_usd: Number((Number(d.spend_usd) * 0.33).toFixed(2)),
          meta_conversions: Math.round(Number(d.meta_conversions) * 0.45),
        })),
      };
    }
    return { campaign_id: requested, timezone: base.timezone, days: [], note: "no delivery in window (fixture)" };
  }

  if (toolName === "operator_db__query") {
    const sql = String(args.sql ?? "").toLowerCase();
    if (sql.includes("information_schema") || sql.includes("show tables") || sql.includes("\\dt")) {
      return {
        tables: ["bookings", "rentals", "listings", "cancellations", "users", "payments"],
        note: "fixture schema",
      };
    }
    if (sql.includes("listing") || sql.includes("availability") || sql.includes("capacity")) {
      return {
        rows: [
          { city: "Austin", active_listings: 41, avg_concurrent_rentals: 13.8, owner_decline_rate: 0.29 },
        ],
        note: "fixture — Austin is at ~14 concurrent, the ops ceiling in /memory/ops.md",
      };
    }
    return fixture;
  }

  if (toolName === "memory__search") {
    const q = String(args.query ?? "").toLowerCase();
    const all = (fixture as { hits: Array<{ slug: string; text: string }> }).hits;
    const hits = all.filter((h) => q.split(/\s+/).some((w) => w.length > 3 && h.text.toLowerCase().includes(w)));
    return { hits: hits.length ? hits : all, matched: hits.length };
  }

  return fixture;
}

export function makeStudioDispatchTool(log: StudioToolLog[] = []) {
  return async function dispatchTool(call: EngineToolCall): Promise<EngineToolResult> {
    const started = Date.now();

    if (call.tool_name === "slack__post_message") {
      const ms = Date.now() - started;
      log.push({ tool: call.tool_name, denied: true, ms });
      return {
        is_error: true,
        denied: true,
        ms,
        code: "tool_denied_local_fixture",
        content:
          "DENIED: writes are disabled in the local Studio harness. " +
          "In production this call would emit a `decisions` row and wait for approval. " +
          "Describe what you would have sent instead.",
      };
    }

    const fixture = FIXTURES[call.tool_name];
    const ms = Date.now() - started;
    log.push({ tool: call.tool_name, denied: false, ms });

    if (fixture === undefined) {
      return {
        is_error: true,
        ms,
        code: "no_fixture",
        content: `No local fixture for "${call.tool_name}". Available: ${Object.keys(FIXTURES).join(", ")}`,
      };
    }
    const body = varyByArgs(call.tool_name, call.input, fixture) as Record<string, unknown>;
    return {
      is_error: false,
      ms,
      content: JSON.stringify({
        ...body,
        _args_received: call.input ?? {},
      }),
    };
  };
}
