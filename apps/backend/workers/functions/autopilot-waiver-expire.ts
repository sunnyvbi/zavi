
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

type ExpiredRow = {
  tenant_id: string;
  decision_class: string;
  waiver_expires_at: string;
};

export async function expireWaiverBatch(
  rows: ExpiredRow[],
  revoke: (tenant_id: string, decision_class: string) => Promise<{ ok: boolean; had_waiver: boolean; error?: string }>,
): Promise<{ scanned: number; revoked: number; idempotent_noop: number; failed: number }> {
  let revoked = 0;
  let idempotent_noop = 0;
  let failed = 0;
  for (const row of rows) {
    const r = await revoke(row.tenant_id, row.decision_class);
    if (!r.ok) {
      failed++;
      await logEvent({
        level: "warn",
        source: "autopilot-waiver-expire",
        code: "autopilot_waiver_revoke_failed",
        message: `revoke_autopilot_waiver failed: ${r.error ?? "unknown"}`,
        tenant_id: row.tenant_id,
        meta: { decision_class: row.decision_class },
      });
      continue;
    }
    if (r.had_waiver) {
      revoked++;
    } else {
      idempotent_noop++;
    }
  }
  return { scanned: rows.length, revoked, idempotent_noop, failed };
}

export const autopilotWaiverExpireFn = inngest.createFunction(
  { id: "autopilot-waiver-expire", concurrency: 1 },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const svc = serviceClient();
    const { data, error } = await svc
      .from("tenant_decision_class_overrides")
      .select("tenant_id, decision_class, waiver_expires_at")
      .not("waiver_expires_at", "is", null)
      .lt("waiver_expires_at", new Date().toISOString())
      .limit(200);
    if (error) {
      throw new Error(`autopilot-waiver-expire scan failed: ${error.message}`);
    }
    const rows = (data ?? []) as ExpiredRow[];
    const result = await expireWaiverBatch(rows, async (tenant_id, decision_class) => {
      const { data: revokeData, error: revokeErr } = await svc.rpc("revoke_autopilot_waiver", {
        p_tenant_id: tenant_id,
        p_decision_class: decision_class,
      });
      if (revokeErr) {
        return { ok: false, had_waiver: false, error: revokeErr.message };
      }
      const obj = (revokeData ?? {}) as { ok?: boolean; had_waiver?: boolean };
      return { ok: !!obj.ok, had_waiver: !!obj.had_waiver };
    });
    logger.info(
      `autopilot-waiver-expire: scanned ${result.scanned}, revoked ${result.revoked}, noop ${result.idempotent_noop}, failed ${result.failed}`,
    );
    return result;
  },
);
