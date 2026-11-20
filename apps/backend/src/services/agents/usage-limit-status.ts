
import { parseUsageLimit } from "@/services/agents/usage-limit-alert";

export type UsageLimitVerdict = "limited" | "ok" | "unknown";

export interface UsageLimitRunRow {
  id: string;
  agent_slug: string | null;
  tenant_id: string | null;
  status: string | null;
  error: string | null;
  finished_at: string | null;
}

export interface UsageLimitStatus {
  status: UsageLimitVerdict;
  limited: boolean;
  resets_at: string | null;
  limit_error_count: number;
  runs_scanned: number;
  last_limit_at: string | null;
  last_limit_run: { id: string; agent_slug: string | null; tenant_id: string | null } | null;
  last_success_at: string | null;
}

function ts(s: string | null): number {
  if (!s) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function classifyUsageLimitStatus(
  rows: UsageLimitRunRow[],
  isLimitError: (error: string) => boolean = (e) => parseUsageLimit(e).hit,
): UsageLimitStatus {
  if (!rows || rows.length === 0) {
    return {
      status: "unknown",
      limited: false,
      resets_at: null,
      limit_error_count: 0,
      runs_scanned: 0,
      last_limit_at: null,
      last_limit_run: null,
      last_success_at: null,
    };
  }

  const limitRows = rows.filter((r) => r.error != null && isLimitError(r.error));

  let latestLimit: UsageLimitRunRow | null = null;
  for (const r of limitRows) {
    if (!latestLimit || ts(r.finished_at) > ts(latestLimit.finished_at)) {
      latestLimit = r;
    }
  }

  let lastSuccessAt: string | null = null;
  for (const r of rows) {
    if (r.status === "success" && ts(r.finished_at) > ts(lastSuccessAt)) {
      lastSuccessAt = r.finished_at;
    }
  }

  const recovered =
    latestLimit != null && ts(lastSuccessAt) > ts(latestLimit.finished_at);
  const limited = latestLimit != null && !recovered;

  return {
    status: limited ? "limited" : "ok",
    limited,
    resets_at: latestLimit ? parseUsageLimit(latestLimit.error ?? "").resetsAt : null,
    limit_error_count: limitRows.length,
    runs_scanned: rows.length,
    last_limit_at: latestLimit?.finished_at ?? null,
    last_limit_run: latestLimit
      ? {
          id: latestLimit.id,
          agent_slug: latestLimit.agent_slug,
          tenant_id: latestLimit.tenant_id,
        }
      : null,
    last_success_at: lastSuccessAt,
  };
}
