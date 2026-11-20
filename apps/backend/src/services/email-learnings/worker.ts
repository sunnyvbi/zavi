
import { asTenantId, staffCrossTenantClient, tenantRpc } from "@/services/tenant-client";
import { recomputeLearnings } from "./recompute";
import { SeedStopped, seedLearnings, type SeedGuard, type StopReason } from "./seed";

export type WorkRow = { id: string; tenant_id: string; kind: "result" | "seed"; dedupe_key: string; lease_token: string; attempts: number };
export type WorkOutcome = "done" | "failed" | "released";

export type LearnPassDeps = {
  repair: (limit: number) => Promise<number>;
  claim: (limit: number, leaseSeconds: number) => Promise<WorkRow[]>;
  complete: (tenantId: string, rows: WorkRow[], outcome: WorkOutcome, error: string | null) => Promise<number>;
  extend: (tenantId: string, rows: WorkRow[], seconds: number) => Promise<boolean>;
  seed: (tenantId: string, guard: SeedGuard, stillOurs: () => Promise<boolean>) => Promise<{ complete: boolean; stopped?: StopReason }>;
  log?: (msg: string) => void;
  recompute: (tenantId: string) => Promise<unknown>;
  now: () => number;
};

export const LEARN_PASS = { limit: 25, leaseSeconds: 600, repairLimit: 200, budgetMs: 4 * 60_000, heartbeatMs: 2 * 60_000 };

export async function runEmailLearnPass(deps: LearnPassDeps = LIVE): Promise<{ repaired: number; tenants: number; failed: number; released: number }> {
  const started = deps.now();
  const late = () => deps.now() - started > LEARN_PASS.budgetMs;
  const repaired = await deps.repair(LEARN_PASS.repairLimit).catch(() => 0);
  const rows = await deps.claim(LEARN_PASS.limit, LEARN_PASS.leaseSeconds);
  const byTenant = new Map<string, WorkRow[]>();
  for (const r of rows) (byTenant.get(r.tenant_id) ?? byTenant.set(r.tenant_id, []).get(r.tenant_id)!).push(r);
  let failed = 0;
  let released = 0;
  for (const [tenantId, work] of byTenant) {
    if (late()) {
      await deps.complete(tenantId, work, "released", null).catch(() => undefined);
      released++;
      continue;
    }
    let lastBeat = deps.now();
    const stillOurs = async () => {
      const ok = await deps.extend(tenantId, work, LEARN_PASS.leaseSeconds).catch(() => false);
      if (ok) lastBeat = deps.now();
      return ok;
    };
    const guard: SeedGuard = async () => {
      if (late()) throw new SeedStopped("budget");
      if (deps.now() - lastBeat >= LEARN_PASS.heartbeatMs && !(await stillOurs())) throw new SeedStopped("lease_lost");
    };
    const finish = async (rs: WorkRow[], outcome: WorkOutcome, error: string | null) => {
      if (rs.length === 0) return;
      const n = await deps.complete(tenantId, rs, outcome, error);
      if (n < rs.length) (deps.log ?? console.warn)(`[email-learnings] ${rs.length - n} work row(s) of ${tenantId} were no longer this pass's`);
    };
    try {
      const seeds = work.filter((w) => w.kind === "seed");
      const results = work.filter((w) => w.kind !== "seed");
      let seedOk = true;
      if (seeds.length) {
        const r = await deps.seed(tenantId, guard, stillOurs);
        if (r.stopped === "lease_lost") continue;
        if (r.stopped === "budget") {
          await finish(work, "released", null);
          released++;
          continue;
        }
        seedOk = r.complete;
      }
      await deps.recompute(tenantId);
      await finish(results, "done", null);
      await finish(seeds, seedOk ? "done" : "failed", seedOk ? null : "a tool was busy, unreadable or read only in part");
    } catch (e) {
      failed++;
      await finish(work, "failed", (e as Error)?.message ?? "failed").catch(() => undefined);
    }
  }
  return { repaired, tenants: byTenant.size, failed, released };
}

const cross = () => staffCrossTenantClient("email learnings: the cross-tenant work claim and repair scan");

const LIVE: LearnPassDeps = {
  repair: async (limit) => {
    const { data, error } = await cross().rpc("repair_email_learn_work", { p_limit: limit });
    if (error) throw new Error("repair_email_learn_work failed");
    return typeof data === "number" ? data : 0;
  },
  claim: async (limit, leaseSeconds) => {
    const { data, error } = await cross().rpc("claim_email_learn_work", { p_limit: limit, p_lease_seconds: leaseSeconds });
    if (error) throw new Error("claim_email_learn_work failed");
    return (Array.isArray(data) ? data : []) as WorkRow[];
  },
  complete: async (tenantId, rows, outcome, error) => {
    const { data, error: e } = await tenantRpc(asTenantId(tenantId), "complete_email_learn_work", {
      p_ids: rows.map((r) => ({ id: r.id, lease_token: r.lease_token })),
      p_outcome: outcome,
      p_error: error,
    });
    if (e) throw new Error("complete_email_learn_work failed");
    return typeof data === "number" ? data : 0;
  },
  extend: async (tenantId, rows, seconds) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "extend_email_learn_lease", {
      p_ids: rows.map((r) => ({ id: r.id, lease_token: r.lease_token })),
      p_seconds: seconds,
    });
    return !error && data === true;
  },
  seed: (tenantId, guard, stillOurs) => seedLearnings(tenantId, undefined, guard, stillOurs),
  recompute: (tenantId) => recomputeLearnings(tenantId),
  now: () => Date.now(),
};
