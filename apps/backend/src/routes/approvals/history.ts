
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { CGO_APPROVER_LABEL } from "@/services/tools/slack/provenance-footer";

const KNOWN_STATUSES = new Set([
  "proposed",
  "approved",
  "rejected",
  "acted",
  "dispatching",
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export async function approvalsHistory(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);

  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const statusFilter =
    typeof req.query.status === "string" && KNOWN_STATUSES.has(req.query.status)
      ? req.query.status
      : null;
  const agentSlug =
    typeof req.query.agent_slug === "string" && req.query.agent_slug.trim()
      ? req.query.agent_slug.trim()
      : null;

  let query = supabase
    .from("decisions")
    .select(
      "id, agent_run_id, decision_class, body, status, autonomy_at_emit, handler, emitted_at, approved_by, approved_at, approved_by_source, rejected_by, rejected_at, dispatched_at, dispatch_error",
    )
    .eq("tenant_id", auth.tenant_id)
    .neq("status", "proposed")
    .order("emitted_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }
  if (agentSlug) {
    const escaped = agentSlug.replace(/([%_\\])/g, "\\$1");
    query = query.or(`decision_class.eq.${escaped},decision_class.like.${escaped}.%`);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: { code: "history_failed", message: error.message } });
    return;
  }

  const rows = (data ?? []) as DecisionRow[];
  const decisions = await enrichWithActors(supabase, auth.tenant_id, rows);

  res.json({
    decisions,
    page: { limit, offset, count: decisions.length },
  });
}

export type DecisionRow = {
  status: string;
  approved_by: string | null;
  approved_by_source?: string | null;
  rejected_by: string | null;
  dispatch_error?: string | null;
  [k: string]: unknown;
};

export function effectiveActor(
  row: DecisionRow,
): { kind: "approved" | "rejected" | "auto" | "failed"; user_id: string | null } {
  if (row.status === "dispatch_failed") {
    return { kind: "failed", user_id: row.approved_by };
  }
  if (row.status === "rejected") {
    if (row.dispatch_error != null && row.dispatch_error !== "") {
      return { kind: "failed", user_id: row.approved_by };
    }
    return { kind: "rejected", user_id: row.rejected_by ?? row.approved_by };
  }
  return { kind: row.approved_by ? "approved" : "auto", user_id: row.approved_by };
}

async function enrichWithActors(
  supabase: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  rows: DecisionRow[],
): Promise<Array<DecisionRow & { actor: { kind: string; user_id: string | null; label: string | null } }>> {
  const actors = rows.map(effectiveActor);
  const ids = Array.from(new Set(actors.map((a) => a.user_id).filter((x): x is string => !!x)));

  const labelById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: resolved } = await supabase.rpc("resolve_decision_actors", {
      p_tenant_id: tenant_id,
      p_user_ids: ids,
    });
    for (const r of (resolved ?? []) as Array<{ user_id: string; label: string }>) {
      labelById.set(r.user_id, r.label);
    }
  }

  return rows.map((row, i) => {
    const a = actors[i];
    return {
      ...row,
      actor: { kind: a.kind, user_id: a.user_id, label: actorLabel(row, a, labelById) },
    };
  });
}

export function actorLabel(
  row: DecisionRow,
  a: ReturnType<typeof effectiveActor>,
  labelById: ReadonlyMap<string, string>,
): string | null {
  if ((a.kind === "approved" || a.kind === "failed") && row.approved_by_source === "cgo") return CGO_APPROVER_LABEL;
  return a.user_id ? (labelById.get(a.user_id) ?? null) : null;
}
