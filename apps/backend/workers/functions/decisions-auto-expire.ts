
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { PAUSED_AWAITING_APPROVAL } from "@/services/agents/approve-resume";
import { isCriticalDecision } from "@/services/decisions/is-critical";

const EXPIRE_AFTER_DAYS = 7;

const ALWAYS_EXPIRE_CLASSES = new Set(["pm.needs_action"]);

const NEVER_EXPIRE_CLASSES = new Set(["operator_db.unreachable"]);

type ProposedAgeRow = { id: string; tenant_id: string };

type ScannedDecisionRow = ProposedAgeRow & {
  decision_class: string | null;
  body: unknown;
};

export function partitionExpirable(scanned: ScannedDecisionRow[]): {
  expirable: ProposedAgeRow[];
  criticalHeld: number;
} {
  const expirable: ProposedAgeRow[] = [];
  let criticalHeld = 0;
  for (const r of scanned) {
    if (NEVER_EXPIRE_CLASSES.has(r.decision_class ?? "")) {
      criticalHeld++;
      continue;
    }
    if (!ALWAYS_EXPIRE_CLASSES.has(r.decision_class ?? "") && isCriticalDecision(r.decision_class, r.body)) {
      criticalHeld++;
      continue;
    }
    expirable.push({ id: r.id, tenant_id: r.tenant_id });
  }
  return { expirable, criticalHeld };
}

export type ExpireDeps = {
  loadStale: (cutoffIso: string) => Promise<ProposedAgeRow[]>;
  expireForTenant: (tenant_id: string, ids: string[]) => Promise<number>;
};

export async function expireStaleDecisions(
  rows: ProposedAgeRow[],
  deps: Pick<ExpireDeps, "expireForTenant">,
): Promise<{ scanned: number; expired: number; tenants: number; failed_tenants: number }> {
  const byTenant = new Map<string, string[]>();
  for (const r of rows) {
    const list = byTenant.get(r.tenant_id) ?? [];
    list.push(r.id);
    byTenant.set(r.tenant_id, list);
  }

  let expired = 0;
  let failed_tenants = 0;
  for (const [tenant_id, ids] of byTenant) {
    try {
      const n = await deps.expireForTenant(tenant_id, ids);
      expired += n;
    } catch (e) {
      failed_tenants++;
      await logEvent({
        level: "warn",
        source: "decisions-auto-expire",
        code: "decision_expire_tenant_failed",
        message: `expire failed: ${(e as Error)?.message ?? "unknown"}`,
        tenant_id,
        meta: { count: ids.length },
      });
    }
  }
  return { scanned: rows.length, expired, tenants: byTenant.size, failed_tenants };
}

export function distinctThreadIds(
  rows: Array<{ thread_id: string | null }>,
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.thread_id === "string" && r.thread_id.length > 0) {
      seen.add(r.thread_id);
    }
  }
  return [...seen];
}

export async function terminalizeTimedOutPausedRuns(
  tenant_id: string,
  agentRunIds: string[],
  deps: {
    cancelPausedRuns: (
      tenant_id: string,
      runIds: string[],
    ) => Promise<Array<{ id: string; thread_id: string | null }>>;
    promoteThread: (tenant_id: string, thread_id: string) => Promise<void>;
  },
): Promise<{ cancelled: number; promoted: number }> {
  if (agentRunIds.length === 0) return { cancelled: 0, promoted: 0 };
  const cancelled = await deps.cancelPausedRuns(tenant_id, agentRunIds);
  let promoted = 0;
  for (const thread_id of distinctThreadIds(cancelled)) {
    try {
      await deps.promoteThread(tenant_id, thread_id);
      promoted++;
    } catch (e) {
      console.warn(
        `[decisions-auto-expire] promote_next_blocked_run failed for thread ${thread_id} (tenant ${tenant_id}): ${(e as Error).message}`,
      );
    }
  }
  return { cancelled: cancelled.length, promoted };
}

export const decisionsAutoExpireFn = inngest.createFunction(
  { id: "decisions-auto-expire", concurrency: 1 },
  { cron: "30 4 * * *" },
  async ({ logger }) => {
    const svc = serviceClient();
    const cutoffIso = new Date(
      Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data, error } = await svc
      .from("decisions")
      .select("id, tenant_id, decision_class, body")
      .eq("status", "proposed")
      .lt("emitted_at", cutoffIso)
      .limit(2000);
    if (error) {
      throw new Error(`decisions-auto-expire scan failed: ${error.message}`);
    }
    const scanned = (data ?? []) as ScannedDecisionRow[];
    const { expirable: rows, criticalHeld } = partitionExpirable(scanned);
    if (criticalHeld > 0) {
      await logEvent({
        level: "info",
        source: "decisions-auto-expire",
        code: "decisions_critical_held",
        message: `held ${criticalHeld} security/money-critical decision(s) from auto-expiry`,
        meta: { count: criticalHeld },
      });
    }

    const result = await expireStaleDecisions(rows, {
      expireForTenant: async (tenant_id, ids) => {
        const { data: updated, error: updErr } = await svc
          .from("decisions")
          .update({ status: "expired" })
          .eq("tenant_id", tenant_id)
          .eq("status", "proposed")
          .lt("emitted_at", cutoffIso)
          .in("id", ids)
          .select("id, agent_run_id");
        if (updErr) throw new Error(updErr.message);
        const expiredRows = (updated ?? []) as Array<{
          id: string;
          agent_run_id: string | null;
        }>;
        const n = expiredRows.length;
        if (n > 0) {
          await logEvent({
            level: "info",
            source: "decisions-auto-expire",
            code: "decisions_expired",
            message: `expired ${n} stale proposed decision(s) (>${EXPIRE_AFTER_DAYS}d)`,
            tenant_id,
            meta: { count: n },
          });

          try {
            {
              const runIds = expiredRows
                .map((r) => r.agent_run_id)
                .filter((x): x is string => typeof x === "string" && x.length > 0);
              await terminalizeTimedOutPausedRuns(tenant_id, runIds, {
                cancelPausedRuns: async (tid, ids) => {
                  const { data, error } = await svc
                    .from("agent_runs")
                    .update({ status: "cancelled" })
                    .eq("tenant_id", tid)
                    .eq("status", PAUSED_AWAITING_APPROVAL)
                    .in("id", ids)
                    .select("id, payload");
                  if (error) throw new Error(error.message);
                  return ((data ?? []) as Array<{ id: string; payload: unknown }>).map(
                    (r) => {
                      const p =
                        r.payload && typeof r.payload === "object"
                          ? (r.payload as { thread_id?: unknown })
                          : {};
                      return {
                        id: r.id,
                        thread_id:
                          typeof p.thread_id === "string" ? p.thread_id : null,
                      };
                    },
                  );
                },
                promoteThread: async (tid, thread_id) => {
                  const { error } = await svc.rpc("promote_next_blocked_run", {
                    p_tenant_id: tid,
                    p_thread_id: thread_id,
                  });
                  if (error) throw new Error(error.message);
                },
              });
            }
          } catch (e) {
            console.warn(
              `[decisions-auto-expire] paused-run terminalize threw for tenant ${tenant_id}: ${(e as Error).message}`,
            );
          }
        }
        return n;
      },
    });

    logger.info(
      `decisions-auto-expire: scanned ${result.scanned}, expired ${result.expired}, tenants ${result.tenants}, failed ${result.failed_tenants}`,
    );
    return result;
  },
);
