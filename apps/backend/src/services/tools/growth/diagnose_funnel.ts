
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import { SAFE_GEO_CATEGORY_RE } from "@/services/tools/operator-db/aggregates";
import {
  readNativeFunnel,
  DEFAULT_FUNNEL_STEPS,
} from "@/services/tools/growth/native_funnel";

const inputSchema = z.object({
  geo: z.string().regex(SAFE_GEO_CATEGORY_RE).optional(),
  category: z.string().regex(SAFE_GEO_CATEGORY_RE).optional(),
  funnel_steps: z.array(z.string()).optional(),
  window_days: z.number().int().min(1).max(365).optional(),
});

export const diagnoseFunnelTool: ToolSpec = {
  name: "growth_diagnose_funnel",
  effect: "read",
  description:
    "Diagnose the tenant's growth funnel (AARRR: acquisition→activation→retention→referral→revenue). Read-only. Call this FIRST; its output tells you which growth levers to pull. Prefers the tenant's NATIVE product-event funnel (their own instrumented signup→activation→key_action→purchase events) when present, and otherwise falls back to their connected operator DB. Errors: operator_db_not_connected = no native funnel and no DB (recommend instrumenting the product or connecting a database); operator_db_read_failed = the DB is connected but the read failed (retry, or tell the founder; never ask them to connect it); operator_db_unsupported_for_db_type = the connected DB type has no funnel read.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);

    const native = await readNativeFunnel(
      ctx.tenant_id,
      args.funnel_steps ?? [...DEFAULT_FUNNEL_STEPS],
      args.window_days ?? 30,
    );
    if (native.has_data) {
      return {
        diagnosis_source: "native_events",
        funnel: native,
      };
    }

    const res = await safeOperatorDbCall(ctx.tenant_id, "query_funnel_by_geo_category", {
      ...(args.geo ? { focus_city: args.geo } : {}),
      ...(args.category ? { focus_category: args.category } : {}),
    });
    if (res.ok) {
      return {
        diagnosis_source: "operator_db_query_funnel_by_geo_category",
        funnel: parseContent(res.content),
      };
    }

    if (res.code === "operator_db_aggregate_not_yet_implemented") {
      const window_days = args.window_days ?? 30;
      const [users, bookings] = await Promise.all([
        safeOperatorDbCall(ctx.tenant_id, "query_new_users", { window_days }),
        safeOperatorDbCall(ctx.tenant_id, "query_new_bookings", { window_days }),
      ]);
      const signups = users.ok ? availableCount(users.content) : null;
      const booked = bookings.ok ? availableCount(bookings.content) : null;
      if (signups !== null || booked !== null) {
        return {
          diagnosis_source: "operator_db_window_counts",
          funnel: { window_days, signups, bookings: booked },
          caveats: [
            "This database type has no geo/category funnel read, so this is new signups and new bookings over the window only. A null count could not be read; it is not zero.",
            ...(args.geo || args.category ? ["The geo/category filter was not applied."] : []),
          ],
        };
      }
      const reads = [users, bookings];
      if (!reads.every((r) => !r.ok && r.code === "operator_db_aggregate_not_yet_implemented")) {
        const failed = reads.find((r) => !r.ok && r.code !== "operator_db_aggregate_not_yet_implemented");
        const reason =
          failed && !failed.ok
            ? failed.code
            : unavailableReason(users.ok ? users.content : bookings.ok ? bookings.content : "");
        throw new ExpectedToolError(
          "operator_db_read_failed",
          "The operator database is connected but the funnel read failed. Retry once; if it fails again, tell the founder the read failed. Do not ask them to connect their database.",
          { reason },
        );
      }
      throw new ExpectedToolError(
        "operator_db_unsupported_for_db_type",
        "The connected database type has no funnel read yet. Use operator_db_query with an explicit pipeline, or say the funnel is unmeasured for this database type.",
      );
    }

    if (res.code === "operator_db_not_connected") {
      throw new ExpectedToolError(
        "operator_db_not_connected",
        "No native product events and no operator database are connected. Recommend the operator instrument their product (POST /api/events/ingest) or connect their database in /settings.",
      );
    }

    throw new ExpectedToolError(
      "operator_db_read_failed",
      "The operator database is connected but the funnel read failed. Retry once; if it fails again, tell the founder the read failed. Do not ask them to connect their database.",
      { reason: res.code },
    );
  },
};

type OpDbOutcome = { ok: true; content: string } | { ok: false; code: string };

async function safeOperatorDbCall(
  tenant_id: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<OpDbOutcome> {
  try {
    const res = await callOperatorDbTool(tenant_id, tool, args);
    if (res.ok && !res.is_error) return { ok: true, content: res.content };
    const parsed = parseContent(res.content) as { error?: unknown } | null;
    return { ok: false, code: typeof parsed?.error === "string" ? parsed.error : "unknown_error" };
  } catch (e) {
    return { ok: false, code: `driver_error:${e instanceof Error ? e.constructor.name : typeof e}` };
  }
}

function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return { raw: content };
  }
}

function unavailableReason(content: string): string {
  const parsed = parseContent(content) as { data?: { reason?: unknown; detail?: unknown } } | null;
  const d = parsed?.data;
  return `counts_unavailable:${String(d?.detail ?? d?.reason ?? "unknown")}`.slice(0, 120);
}

function availableCount(content: string): number | null {
  const parsed = parseContent(content) as { data?: { available?: boolean; count?: unknown } } | null;
  if (parsed?.data?.available !== true) return null;
  const n = Number(parsed.data.count);
  return Number.isFinite(n) ? n : null;
}
