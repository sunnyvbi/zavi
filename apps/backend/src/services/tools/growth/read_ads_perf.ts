
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { callGoogleAdsTool } from "@/services/mcp/internal/google-ads";
import { callMetaAdsTool } from "@/services/mcp/internal/meta-ads";
import type { McpCallResult } from "@/services/mcp/types";
import { fullDaysWindow } from "@/services/tools/ad-window";
import { isOutsidePaidChannelTool } from "@/services/agents/paid-channel-scope";

const inputSchema = z.object({
  window_days: z.number().int().min(1).max(90).default(7),
});

const NOT_CONNECTED_CODES = new Set([
  "google_ads_not_connected",
  "google_ads_not_configured",
  "meta_ads_not_connected",
]);

function asFailedCall(e: unknown): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "read_failed",
      message: e instanceof Error ? e.message : "ads read failed",
    }),
    ms: 0,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

type PlatformRead =
  | { status: "ok"; body: unknown }
  | { status: "not_connected" }
  | { status: "read_failed"; reason: string };

function classify(res: McpCallResult): PlatformRead {
  if (res.ok && !res.is_error) return { status: "ok", body: safeParse(res.content) };
  const parsed = safeParse(res.content) as { error?: unknown; message?: unknown } | null;
  const code = typeof parsed?.error === "string" ? parsed.error : "unknown_error";
  if (NOT_CONNECTED_CODES.has(code)) return { status: "not_connected" };
  const message = typeof parsed?.message === "string" ? parsed.message.slice(0, 200) : "";
  return { status: "read_failed", reason: message ? `${code}: ${message}` : code };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export { fullDaysWindow };

export const readAdsPerfTool: ToolSpec = {
  name: "growth_read_ads_perf",
  effect: "read",
  description:
    "Read the operator's paid-ads performance: Google Ads + Meta Ads campaign lists over ONE shared window (the last `window_days` full days ending yesterday, default 7, every campaign status; the window is in the payload). Read-only. Each platform is `not_connected`, `read_failed` (connected, but the read failed: retry or tell the founder, never ask them to connect it), or its data. Throws ads_not_connected when neither platform is connected, and ads_read_failed when none answered and at least one is connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if (isOutsidePaidChannelTool(ctx.agent_slug, "growth", "read_ads_perf")) {
      throw new ExpectedToolError(
        "channel_scope_mismatch",
        "This combined reader returns Google and Meta data. Use your own channel's native performance reader instead.",
      );
    }
    const { window_days } = inputSchema.parse(input ?? {});
    const window = fullDaysWindow(window_days);
    const [gRes, mRes] = await Promise.all([
      callGoogleAdsTool({ tenant_id: ctx.tenant_id }, "list_campaigns", {
        custom_range: window,
        status: "ALL",
      }).catch(asFailedCall),
      callMetaAdsTool({ tenant_id: ctx.tenant_id }, "list_campaigns", {
        time_range: window,
        status: "ALL",
      }).catch(asFailedCall),
    ]);
    const g = classify(gRes);
    const m = classify(mRes);

    if (g.status !== "ok" && m.status !== "ok") {
      if (g.status === "not_connected" && m.status === "not_connected") {
        throw new ExpectedToolError(
          "ads_not_connected",
          "Neither Google Ads nor Meta Ads is connected for this tenant. If the user asked about one ad platform, call connectors__request with its slug (meta_ads or google_ads) instead of pointing them to Settings; otherwise treat paid acquisition as an operator-manual lever and say so in your bets.",
        );
      }
      throw new ExpectedToolError(
        "ads_read_failed",
        "An ad account is connected but could not be read (expired token, revoked permission, rate limit or an API error). Retry once; if it still fails, tell the founder the read failed and the connection is worth re-checking. Do not say they have no ad account.",
        {
          google_ads: g.status === "read_failed" ? g.reason : g.status,
          meta_ads: m.status === "read_failed" ? m.reason : m.status,
        },
      );
    }

    const out = (r: PlatformRead): unknown =>
      r.status === "ok"
        ? r.body
        : r.status === "not_connected"
          ? { not_connected: true }
          : { read_failed: true, reason: r.reason };
    return {
      window: { ...window, days: window_days, statuses: "ALL" },
      google_ads: out(g),
      meta_ads: out(m),
    };
  },
};
