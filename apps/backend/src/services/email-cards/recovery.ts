import type { SendCounts } from "@/services/comms/bulk-outbound/store";
import { bulkSendOutcome, type SendOutcome } from "./outcome";
import { opsRpc } from "@/services/tenant-client";

type Redispatch = { action: "redispatch" | "expired"; tenant_id: string; decision_id: string; decision_class: string; redispatch_key?: string; paused?: boolean; sender_stopped?: boolean };
type Stalled = { action: "refire" | "give_up"; send_id: string; tenant_id: string; decision_id: string; attempt?: number; sent?: number; total?: number };
type Event = { id: string; name: "decision.approved" | "bulk-email/fanout.requested"; data: Record<string, unknown> };

export type RecoveryDeps = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  send: (e: Event) => Promise<void>;
  tell: (o: SendOutcome) => Promise<unknown>;
  counts: (tenantId: string, sendId: string) => Promise<SendCounts>;
};

export const RELEASED_EXPIRED_REASON = "Zavi could not start this send within a day of its approval, so it did not send it.";
export const RELEASED_PAUSED_REASON =
  "Email was paused for this workspace, so Zavi held this send, and email was not resumed within a day of its approval. Zavi did not send it, so an old email never goes out late.";
export const RELEASED_SENDER_STOPPED_REASON =
  "Zavi's own sender was stopped for every workspace, so Zavi held this send, and the sender was not running again within a day of its approval. Zavi did not send it, so an old email never goes out late.";
export const FANOUT_STALLED_REASON = "Zavi's sender stopped making progress on this send and could not restart it, so the rest of the list was not emailed.";

export function notEmailedLine(sent: number, total: number | null | undefined): string {
  const all = typeof total === "number" && Number.isFinite(total) ? total : null;
  const left = all === null ? 0 : Math.max(0, all - sent);
  if (all === null || !(left > 0)) return "Zavi will not send it to the rest of the list on its own.";
  return `${left.toLocaleString("en-US")} of the ${all.toLocaleString("en-US")} ${all === 1 ? "person" : "people"} on the list ${left === 1 ? "was" : "were"} not emailed, and Zavi will not send it to them on its own.`;
}

export function stalledSendNote(sent: number, total: number | null | undefined): string {
  return `${FANOUT_STALLED_REASON} ${notEmailedLine(sent, total)}`;
}

const LIVE: RecoveryDeps = {
  rpc: async (name, args) => {
    const { data, error } = await opsRpc(name, args);
    if (error) throw new Error(`${name} failed`);
    return data;
  },
  send: async (e) => {
    const { inngest } = await import("@/../workers/client");
    await inngest.send(e as never);
  },
  tell: async (o) => (await import("./outcome-tell")).tellEmailSendOutcomeOrQueue(o),
  counts: async (tenantId, sendId) => {
    const [{ supabaseBulkSendStore: store }, { STALE_SENDING_SECONDS }] = await Promise.all([import("@/services/comms/bulk-outbound/store"), import("@/services/comms/bulk-outbound/fanout")]);
    await store.markStaleUnknown(tenantId, sendId, STALE_SENDING_SECONDS);
    return store.settleSend(tenantId, sendId, null);
  },
};

async function gaveUpOutcome(s: Stalled, deps: RecoveryDeps): Promise<SendOutcome> {
  const fallback: SendOutcome = { tenant_id: s.tenant_id, rail: "decisions", card_id: s.decision_id, outcome: "failed", sent: s.sent ?? null, total: s.total ?? null, reason: FANOUT_STALLED_REASON };
  const c = await deps.counts(s.tenant_id, s.send_id).catch(() => null);
  return (c ? bulkSendOutcome(s.tenant_id, s.decision_id, "held", c, FANOUT_STALLED_REASON, null) : null) ?? fallback;
}

export async function runEmailSendRecovery(depsIn: Partial<RecoveryDeps> = {}): Promise<{ redispatched: number; expired: number; refired: number; gave_up: number }> {
  const deps = { ...LIVE, ...depsIn };
  const out = { redispatched: 0, expired: 0, refired: 0, gave_up: 0 };
  const released = ((await deps.rpc("email_redispatch_released_sweep", { p_limit: 50 })) ?? []) as Redispatch[];
  for (const r of released) {
    if (r.action === "redispatch" && r.redispatch_key) {
      try {
        await deps.send({ id: `approve:${r.decision_id}:${r.redispatch_key}`, name: "decision.approved", data: { decision_id: r.decision_id, tenant_id: r.tenant_id, decision_class: r.decision_class } });
        out.redispatched += 1;
      } catch {
        await deps.rpc("email_redispatch_enqueue_failed", { p_tenant_id: r.tenant_id, p_decision_id: r.decision_id, p_redispatch_key: r.redispatch_key }).catch(() => undefined);
      }
    } else if (r.action === "expired") {
      await deps.tell({ tenant_id: r.tenant_id, rail: "decisions", card_id: r.decision_id, outcome: "failed", sent: 0, reason: r.paused === true ? RELEASED_PAUSED_REASON : r.sender_stopped === true ? RELEASED_SENDER_STOPPED_REASON : RELEASED_EXPIRED_REASON }).catch(() => undefined);
      out.expired += 1;
    }
  }
  const stalled = ((await deps.rpc("email_bulk_stalled_sends", { p_limit: 25, p_stale_minutes: 45, p_max_recoveries: 3 })) ?? []) as Stalled[];
  for (const s of stalled) {
    if (s.action === "refire") {
      try {
        await deps.send({ id: `bulk-email-fanout:${s.send_id}:recover:${s.attempt ?? 0}`, name: "bulk-email/fanout.requested", data: { send_id: s.send_id } });
        out.refired += 1;
      } catch {
        await deps.rpc("email_bulk_refire_enqueue_failed", { p_tenant_id: s.tenant_id, p_send_id: s.send_id, p_attempt: s.attempt ?? 0 }).catch(() => undefined);
      }
    } else if (s.action === "give_up") {
      await deps.tell(await gaveUpOutcome(s, deps)).catch(() => undefined);
      out.gave_up += 1;
    }
  }
  return out;
}
