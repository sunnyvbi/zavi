
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { composioExecuteTool, type ComposioExecResult } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { COMPOSIO_CALL_MS, listPinterestBoards } from "@/services/connectors/pinterest-composio/readiness";

const inputSchema = z.object({
  days: z.number().int().min(7).max(90).default(30).describe("Analytics window ending yesterday (7-90 days; Pinterest keeps 90)."),
  top_pins: z.number().int().min(1).max(50).default(10).describe("How many of the account's top pins to return (1-50)."),
});

const METRICS = ["IMPRESSION", "ENGAGEMENT", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE", "SAVE_RATE", "OUTBOUND_CLICK_RATE"] as const;

type Metrics = Record<string, number>;

export type PinterestBoard = { id: string; name: string; description: string | null; privacy: string | null; pin_count: number | null };
export type PinterestTopPin = { pin_id: string; metrics: Metrics };

export type PinterestInsightsResult = {
  fetched_at: string;
  window: { start_date: string; end_date: string };
  username: string | null;
  account_type: string | null;
  website_url: string | null;
  follower_count: number | null;
  pin_count: number | null;
  board_count: number | null;
  boards: PinterestBoard[];
  boards_error: string | null;
  boards_complete: boolean;
  account_totals: Metrics | null;
  account_error: string | null;
  top_pins: PinterestTopPin[];
  top_pins_error: string | null;
  provenance: "owned";
  cannot_see: string[];
  note: string;
};

export function errOf(r: ComposioExecResult): string {
  return typeof r.error === "string" ? r.error : JSON.stringify(r.error ?? `HTTP ${r.status}`).slice(0, 200);
}
export function dataOf(r: ComposioExecResult): Record<string, any> {
  let d: unknown = r.data;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { d = null; }
  }
  return d && typeof d === "object" ? (d as Record<string, any>) : {};
}
function metricsOf(v: unknown): Metrics {
  const out: Metrics = {};
  if (v && typeof v === "object") {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "number") out[k] = n;
  }
  return out;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isObj = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

export type PinterestExec = (tool_slug: string, args: Record<string, unknown>) => Promise<ComposioExecResult>;

export function pinterestExec(tenantId: string, connectedAccountId: string): PinterestExec {
  return async (tool_slug, args) => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ComposioExecResult>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve({ ok: false, status: 0, data: null, error: "Pinterest did not answer in time", outcome_unknown: true });
      }, COMPOSIO_CALL_MS);
    });
    const call = composioExecuteTool({ tool_slug, user_id: tenantId, connected_account_id: connectedAccountId, arguments: args }, ctrl.signal);
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
  };
}

export const pinterestInsightsReadTool: ToolSpec = {
  name: "pinterest_insights_read",
  effect: "read",
  description:
    "Read the operator's OWN Pinterest account through their connected Pinterest: profile (username, " +
    "followers, pin and board counts), their boards with ids (a staged pin needs a board id), account " +
    "totals over the window (impressions, outbound clicks, pin clicks, saves, save rate) and the top " +
    "pins with their metrics. Needs Pinterest connected in Settings. Quote numbers as returned with the " +
    "window; never extend them to a competitor. One call per run.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const tenantId = ctx.tenant_id;

    const account = await resolveOwnedComposioAccount(tenantId, "pinterest");
    if (!account) {
      throw new ExpectedToolError(
        "pinterest_not_connected",
        "No connected Pinterest account. Ask the operator to connect Pinterest in Settings; until then this channel reads public evidence only.",
        { connector_slug: "composio.pinterest" },
      );
    }
    const exec = pinterestExec(tenantId, account.connected_account_id);

    const profile = await exec("PINTEREST_GET_PROFILE", {});
    if (!profile.ok) {
      throw new ExpectedToolError(
        profile.status === 401 || profile.status === 403 ? "pinterest_not_authorized" : "pinterest_read_failed",
        `Pinterest refused the read (${errOf(profile)}). The operator may need to reconnect Pinterest in Settings.`,
      );
    }
    const profileData = dataOf(profile);
    const wrapped = profileData.response_data ?? profileData.data;
    const p: Record<string, any> = isObj(wrapped) ? wrapped : profileData;

    const end = new Date(Date.now() - 86_400_000);
    const start = new Date(end.getTime() - (input.days - 1) * 86_400_000);
    const window = { start_date: ymd(start), end_date: ymd(end) };

    const [boardList, totalsR, topR] = await Promise.all([
      listPinterestBoards(tenantId),
      exec("PINTEREST_GET_ACCOUNT_ANALYTICS", { ...window, metric_types: [...METRICS] }),
      exec("PINTEREST_GET_TOP_PINS", { ...window, sort_by: "IMPRESSION", num_pins: input.top_pins, metric_types: [...METRICS] }),
    ]);

    const SHAPE = "unexpected response shape";
    const boards: PinterestBoard[] = boardList.ok
      ? boardList.boards.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description ?? null,
          privacy: b.privacy,
          pin_count: b.pin_count ?? null,
        }))
      : [];

    const summary = totalsR.ok ? dataOf(totalsR).analytics?.all?.summary_metrics : undefined;
    const topItems = topR.ok ? dataOf(topR).pins : undefined;
    const top_pins: PinterestTopPin[] = Array.isArray(topItems)
      ? (topItems as Array<Record<string, unknown>>).map((t) => ({
          pin_id: String(t.pin_id ?? t.id ?? ""),
          metrics: metricsOf(t.metrics),
        }))
      : [];

    const username = str(p.username);
    return {
      fetched_at: new Date().toISOString(),
      window,
      username,
      account_type: str(p.account_type),
      website_url: str(p.website_url),
      follower_count: num(p.follower_count),
      pin_count: num(p.pin_count),
      board_count: num(p.board_count),
      boards,
      boards_error: boardList.ok ? null : boardList.code,
      boards_complete: boardList.ok && boardList.complete,
      account_totals: totalsR.ok && isObj(summary) ? metricsOf(summary) : null,
      account_error: !totalsR.ok ? errOf(totalsR) : isObj(summary) ? null : SHAPE,
      top_pins,
      top_pins_error: !topR.ok ? errOf(topR) : Array.isArray(topItems) ? null : SHAPE,
      provenance: "owned",
      cannot_see: [
        "any other account's impressions, clicks or saves",
        "analytics older than 90 days",
        "sales from Pinterest (that needs the Pinterest tag on their site)",
      ],
      note: `Owned Pinterest analytics for ${username ? `@${username}` : "the connected account"}, ${window.start_date} to ${window.end_date}. Quote with the window; never average across pins.`,
    } satisfies PinterestInsightsResult;
  },
};
