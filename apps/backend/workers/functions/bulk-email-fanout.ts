
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { defaultFanoutDeps, runBulkChunk, type ChunkResult } from "@/services/comms/bulk-outbound/fanout";
import { bulkSendLine, STAFF_ONLY_HOLDS } from "@/services/comms/bulk-outbound/notices";
import { postBulkSendNotice } from "@/services/comms/bulk-outbound/thread-notice";
import type { SendCounts } from "@/services/comms/bulk-outbound/store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROUNDS = 60;
export const CHUNK_PAUSE = "5m";
export const THROTTLE_PAUSE = "15m";

export type FanoutHead = { tenant_id: string; status: string; next_run_at: string | null };

export type FanoutStep = {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
  waitForEvent(id: string, opts: { event: "bulk-email/fanout.stopped"; timeout: Date; if: string }): Promise<unknown>;
  sendEvent(id: string, payload: { id: string; name: "bulk-email/fanout.requested"; data: { send_id: string } }): Promise<unknown>;
};

export type FanoutRunDeps = {
  resolveSend: (sendId: string) => Promise<FanoutHead | null>;
  runChunk: (tenantId: string, sendId: string) => Promise<ChunkResult>;
  notify: (tenantId: string, sendId: string, text: string) => Promise<unknown>;
  tell?: (tenantId: string, sendId: string, state: string, counts: { sent: number; total: number; hold_reason?: string | null }, line: string) => Promise<unknown>;
  keep?: (tenantId: string, sendId: string, state: string, counts: { sent: number; total: number; hold_reason?: string | null }, line: string) => Promise<unknown>;
};

type OutcomeCounts = { sent: number; total: number; hold_reason?: string | null };

async function outcomeOf(tenantId: string, sendId: string, state: string, counts: OutcomeCounts, line: string) {
  const { data } = await serviceClient().from("email_bulk_sends").select("decision_id, tenant_id").eq("id", sendId).maybeSingle();
  const row = data as { decision_id?: string; tenant_id?: string } | null;
  if (!row?.decision_id || row.tenant_id !== tenantId) return null;
  const { bulkSendOutcome } = await import("@/services/email-cards/outcome");
  return bulkSendOutcome(tenantId, row.decision_id, state, counts, line);
}

async function tellOutcome(tenantId: string, sendId: string, state: string, counts: OutcomeCounts, line: string): Promise<void> {
  const o = await outcomeOf(tenantId, sendId, state, counts, line);
  if (o) await (await import("@/services/email-cards/outcome")).notifyEmailSendOutcomeOrThrow(o);
}

async function keepOutcome(tenantId: string, sendId: string, state: string, counts: OutcomeCounts, line: string): Promise<boolean> {
  const o = await outcomeOf(tenantId, sendId, state, counts, line);
  return o ? (await import("@/services/email-cards/outcome")).keepEmailSendOutcomeLine(o) : false;
}

async function resolveSendFromRow(sendId: string): Promise<FanoutHead | null> {
  const { data, error } = await serviceClient()
    .from("email_bulk_sends")
    .select("tenant_id, status, next_run_at")
    .eq("id", sendId)
    .maybeSingle();
  if (error) throw new Error("email_bulk_sends read failed");
  return (data as FanoutHead | null) ?? null;
}

const realDeps: FanoutRunDeps = {
  resolveSend: resolveSendFromRow,
  runChunk: async (tenantId, sendId) => runBulkChunk({ tenantId, sendId }, await defaultFanoutDeps()),
  notify: postBulkSendNotice,
  tell: tellOutcome,
  keep: keepOutcome,
};

const finished = (status: string) => status === "done" || status === "failed" || status === "held";

export async function runBulkEmailFanout(
  sendId: string,
  step: FanoutStep,
  deps: FanoutRunDeps = realDeps,
): Promise<{ ok: boolean; state?: string; error?: string }> {
  if (!UUID_RE.test(sendId)) return { ok: false, error: "bad_send_id" };
  const head = await step.run("resolve-send", () => deps.resolveSend(sendId));
  if (!head) return { ok: false, error: "send_not_found" };
  if (finished(head.status)) return { ok: true, state: head.status };

  let until = head.status === "waiting_for_tomorrow" ? head.next_run_at : null;
  let backoff = false;
  let last: SendCounts | null = null;
  let settling = false;
  for (let i = 0; i < MAX_ROUNDS; i += 1) {
    if (until) {
      await step.waitForEvent(`wait-for-allowance-${i}`, {
        event: "bulk-email/fanout.stopped",
        timeout: new Date(until),
        if: `async.data.send_id == "${sendId}"`,
      });
    }
    else await step.sleep(`pause-${i}`, backoff ? THROTTLE_PAUSE : CHUNK_PAUSE);

    const r = await step.run(`chunk-${i}`, () => deps.runChunk(head.tenant_id, sendId));
    if (r.state === "missing") return { ok: false, error: "send_not_found" };
    if (r.state === "held" && r.counts.sending > 0 && STAFF_ONLY_HOLDS.has(r.counts.hold_reason ?? "") && !settling && i < MAX_ROUNDS - 1) {
      settling = true;
      until = null;
      backoff = false;
      last = r.counts;
      continue;
    }
    if (r.state === "done" || r.state === "failed" || r.state === "held") {
      const line = bulkSendLine(r.state, r.counts);
      await step.run("notify", async () => {
        await deps.notify(head.tenant_id, sendId, line);
        return true;
      });
      if (deps.tell) {
        await step
          .run("tell-outcome", async () => {
            await deps.tell!(head.tenant_id, sendId, r.state, r.counts, line);
            return true;
          })
          .catch(async (e) => {
            console.warn(`[bulk-email-fanout] ${sendId}: outcome not told after retries: ${(e as Error).message}`);
            if (!deps.keep) return;
            await step
              .run("keep-outcome-line", async () => {
                await deps.keep!(head.tenant_id, sendId, r.state, r.counts, line);
                return true;
              })
              .catch((k) => console.warn(`[bulk-email-fanout] ${sendId}: outcome line not kept: ${(k as Error).message}`));
          });
      }
      return { ok: true, state: r.state };
    }
    until = r.state === "waiting_for_tomorrow" ? r.counts.next_run_at : null;
    backoff = r.throttled === true;
    last = r.counts;
  }
  const mark = last ? `${last.sent}-${last.skipped}-${last.failed}-${last.unknown}-${last.pending}` : "none";
  await step.sendEvent("continue", { id: `bulk-email-fanout:${sendId}:continue:${mark}`, name: "bulk-email/fanout.requested", data: { send_id: sendId } });
  return { ok: true, state: "continued" };
}

export const bulkEmailFanoutFn = inngest.createFunction(
  {
    id: "bulk-email-fanout",
    retries: 2,
    concurrency: { key: "event.data.send_id", limit: 1 },
  },
  { event: "bulk-email/fanout.requested" },
  async ({ event, step }) => runBulkEmailFanout(String(event.data.send_id ?? ""), step as unknown as FanoutStep),
);
