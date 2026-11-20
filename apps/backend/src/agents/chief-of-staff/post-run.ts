
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import {
  hasWiredRevenueConnector,
  revenueDataAvailable,
  scrubUngroundedRevenue,
} from "./gmv-guard";

export function cosScrubAndAnnotate(
  ctx: AgentContext,
  result: DispatcherResult,
): void {
  if (!revenueDataAvailable(result.tool_calls)) {
    if (result.parsed && typeof result.parsed === "object") {
      scrubUngroundedRevenue(result.parsed as Record<string, unknown>);
    }
    if (typeof result.output_text === "string") {
      const holder = { rendered_markdown: result.output_text };
      scrubUngroundedRevenue(holder);
      result.output_text = holder.rendered_markdown;
    }
  }

  if (
    hasWiredRevenueConnector(result.resolved_tool_names) &&
    !revenueDataAvailable(result.tool_calls)
  ) {
    console.warn(
      `[chief-of-staff] cos.grounding_skipped tenant=${ctx.tenant_id} run=${ctx.runId}: revenue connector wired but no revenue tool returned data this run — output may be stale/inferred.`,
    );
    const p =
      result.parse_ok && result.parsed && typeof result.parsed === "object"
        ? (result.parsed as {
            tier1?: unknown;
            tier2?: unknown;
            tier3?: unknown;
            tier4?: Array<{ category: string; summary: string }>;
          })
        : null;
    const isDigestShaped =
      !!p &&
      (Array.isArray(p.tier1) ||
        Array.isArray(p.tier2) ||
        Array.isArray(p.tier3));
    if (p && isDigestShaped) {
      const line = {
        category: "fleet-health",
        summary:
          "Ran without pulling live numbers — operator_db/stripe were wired but no revenue read happened this run; figures may be stale. Pull recommended.",
      };
      if (!Array.isArray(p.tier4)) p.tier4 = [];
      if (
        !p.tier4.some(
          (t) =>
            t.category === "fleet-health" &&
            t.summary.startsWith("Ran without pulling live numbers"),
        )
      ) {
        p.tier4.push(line);
      }
    }
  }
}
