
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { paraphraseDuplicateRate } from "@/services/memory/write-canary";

type MetricsRow = {
  tenant_id: string;
  added: number;
  duplicate: number;
  updated: number;
  conflict: number;
  rejected: number;
  junk: number;
  cleanup_superseded: number;
  restored: number;
  update_undone: number;
  forgets: number;
  forget_undone: number;
};

const rate = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 1000) / 1000 : 0);

export function shapeWriteMetrics(r: MetricsRow) {
  const n = (x: unknown) => Number(x ?? 0);
  const m = {
    added: n(r.added),
    duplicate: n(r.duplicate),
    updated: n(r.updated),
    conflict: n(r.conflict),
    rejected: n(r.rejected),
    junk: n(r.junk),
  };
  const proposed = m.added + m.duplicate + m.updated + m.conflict + m.rejected + m.junk;
  return {
    tenant_id: r.tenant_id,
    counts: { ...m, cleanup_superseded: n(r.cleanup_superseded), restored: n(r.restored), update_undone: n(r.update_undone), forgets: n(r.forgets), forget_undone: n(r.forget_undone) },
    paraphrase_duplicate_rate: Math.round(paraphraseDuplicateRate(m) * 1000) / 1000,
    skip_rate: rate(m.duplicate + m.rejected + m.junk, proposed),
    reject_rate: rate(m.rejected + m.junk, proposed),
    update_reversal_rate: rate(n(r.update_undone), m.updated),
    forget_undo_rate: rate(n(r.forget_undone), n(r.forgets)),
    forget_rate: rate(n(r.forgets), m.added + m.updated + m.conflict),
  };
}

export async function staffMemoryWriteMetrics(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const daysRaw = typeof req.query.days === "string" ? parseInt(req.query.days, 10) : 7;
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await staffCrossTenantClient("staff memory write-gate metrics (read-only counts)").rpc(
    "memory_write_metrics",
    { p_since: since },
  );
  if (error) {
    res.status(500).json({ error: { code: "metrics_failed", message: error.message } });
    return;
  }
  const workspaces = ((data ?? []) as MetricsRow[]).map(shapeWriteMetrics);
  res.json({ since, days, workspaces });
}
