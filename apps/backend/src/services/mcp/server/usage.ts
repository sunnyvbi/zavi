
import { serviceClient } from "@/services/supabase";

export type McpUsageRow = {
  tool: string;
  code: string;
  ms: number;
  credential_kind: string;
  created_at: string;
};

export type McpToolUsage = {
  tool: string;
  total: number;
  ok: number;
  errors: number;
  last_called_at: string | null;
};

export type McpUsageSummary = {
  tenant_id: string;
  window_days: number;
  total_calls: number;
  by_tool: McpToolUsage[];
  recent: McpUsageRow[];
};

const SELECT_COLS = "tool,code,ms,credential_kind,created_at" as const;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;

export async function getMcpUsageForTenant(
  tenantId: string,
  opts: { windowDays?: number; recentLimit?: number } = {},
): Promise<McpUsageSummary> {
  const windowDays =
    opts.windowDays && opts.windowDays > 0 ? Math.floor(opts.windowDays) : DEFAULT_WINDOW_DAYS;
  const recentLimit = Math.min(
    Math.max(1, Math.floor(opts.recentLimit ?? DEFAULT_RECENT_LIMIT)),
    MAX_RECENT_LIMIT,
  );
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await serviceClient()
    .from("mcp_tool_calls")
    .select(SELECT_COLS)
    .eq("tenant_id", tenantId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getMcpUsageForTenant failed: ${error.message}`);

  const rows = (data ?? []) as McpUsageRow[];

  const byTool = new Map<string, McpToolUsage>();
  for (const r of rows) {
    let agg = byTool.get(r.tool);
    if (!agg) {
      agg = { tool: r.tool, total: 0, ok: 0, errors: 0, last_called_at: null };
      byTool.set(r.tool, agg);
    }
    agg.total += 1;
    if (r.code === "ok") agg.ok += 1;
    else agg.errors += 1;
    if (agg.last_called_at === null) agg.last_called_at = r.created_at;
  }

  const by_tool = [...byTool.values()].sort((a, b) => b.total - a.total);

  return {
    tenant_id: tenantId,
    window_days: windowDays,
    total_calls: rows.length,
    by_tool,
    recent: rows.slice(0, recentLimit),
  };
}
