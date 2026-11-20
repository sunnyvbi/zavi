
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { EmailRoute } from "@/services/email-templates/render";

export type WinMetric = "visitors" | "clicks";
export type WinBasis = "median" | "first_sends" | "no_signal";
export type WinLine = { metric: WinMetric | null; threshold: number | null; basis: WinBasis; n_past: number };

export const WIN_LINE_LOOKBACK = 5;
export const WIN_LINE_MIN_PAST = 3;

export function pickWinMetric(a: { route: EmailRoute; tagged: boolean; gaConnected: boolean }): WinMetric | null {
  if (a.tagged && a.gaConnected) return "visitors";
  if (a.route !== "zavi_list") return "clicks";
  return null;
}

export function rateOf(d7: Record<string, unknown> | null | undefined, metric: WinMetric): number | null {
  const v = d7?.[metric];
  const delivered = d7?.delivered;
  if (typeof v !== "number" || typeof delivered !== "number" || delivered <= 0 || v < 0) return null;
  return v / delivered;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function winLineFrom(metric: WinMetric | null, pastRatesNewestFirst: readonly number[]): WinLine {
  if (!metric) return { metric: null, threshold: null, basis: "no_signal", n_past: 0 };
  const past = pastRatesNewestFirst.slice(0, WIN_LINE_LOOKBACK);
  if (past.length < WIN_LINE_MIN_PAST) return { metric, threshold: null, basis: "first_sends", n_past: past.length };
  return { metric, threshold: Number(median(past).toFixed(6)), basis: "median", n_past: past.length };
}

export type WinLineDeps = {
  pastResults: (tenantId: string, route: EmailRoute, listId: string) => Promise<Array<{ win_line: unknown; d7: unknown }>>;
};

const LIVE: WinLineDeps = {
  pastResults: async (tenantId, route, listId) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_send_results")
      .select("win_line, d7")
      .eq("route", route)
      .eq("list_id", listId)
      .not("d7_published_at", "is", null)
      .order("d7_published_at", { ascending: false })
      .limit(20);
    if (error) throw new Error("email_send_results read failed");
    return (data ?? []) as Array<{ win_line: unknown; d7: unknown }>;
  },
};

export function judgedOnCarried(stage: Record<string, unknown>, metric: string | null | undefined): boolean {
  if (stage.provider_status !== "disconnected" && stage.provider_status !== "could_not_read") return false;
  const carried = Array.isArray(stage.from_h1) ? stage.from_h1 : [];
  return carried.includes("delivered") || (!!metric && carried.includes(metric));
}

export async function computeWinLine(
  tenantId: string,
  a: { route: EmailRoute; listId: string | null; tagged: boolean; gaConnected: boolean },
  depsIn: Partial<WinLineDeps> = {},
): Promise<WinLine> {
  const deps = { ...LIVE, ...depsIn };
  const metric = pickWinMetric(a);
  if (!metric || !a.listId) return winLineFrom(metric, []);
  const rows = await deps.pastResults(tenantId, a.route, a.listId);
  const rates = rows
    .filter((r) => (r.win_line as { metric?: unknown } | null)?.metric === metric && !judgedOnCarried((r.d7 ?? {}) as Record<string, unknown>, metric))
    .map((r) => rateOf(r.d7 as Record<string, unknown>, metric))
    .filter((x): x is number => x !== null);
  return winLineFrom(metric, rates);
}

export function winLineText(w: WinLine | null | undefined): string {
  if (!w || w.basis === "no_signal" || !w.metric) return "No click or visitor signal";
  if (w.basis === "first_sends" || w.threshold === null) return "First send: sets your baseline";
  const pct = `${(w.threshold * 100).toFixed(w.threshold < 0.01 ? 2 : 1)}%`;
  return w.metric === "visitors" ? `${pct} of delivered visit your site` : `${pct} of delivered click`;
}
