
import { logEvent } from "@/services/logging/logEvent";
import { ABUSE_COMPLAINTS_ANY, ABUSE_COMPLAINT_RATE, ABUSE_HARD_BOUNCE_RATE, ABUSE_MIN_SENT, type GlobalBulkStop } from "./config";
import { daysToFinish, guardBulkSend, warmUpIsTheLimit } from "./guard";
import type { BulkSendState } from "./notices";
import { checkBulkReady } from "./readiness";
import type { BulkSendRow, BulkSendStore, SendCounts } from "./store";
import type { BulkWireMessage, BulkWireResult } from "./wire";

export const BULK_CHUNK_SIZE = 100;
export const STALE_SENDING_SECONDS = 120;

export type ChunkResult =
  | { state: "missing" }
  | { state: BulkSendState; counts: SendCounts; days_left?: number; warming_up?: boolean; throttled?: boolean };

export type FanoutDeps = {
  store: BulkSendStore;
  wire: (msg: BulkWireMessage) => Promise<BulkWireResult>;
  checkReady: typeof checkBulkReady;
  unsubToken: (tenantId: string, email: string) => Promise<string>;
  shutOff: (tenantId: string, sendId: string, reason: string) => Promise<void>;
  unverifyDomain: (tenantId: string) => Promise<unknown>;
  replyTo: (tenantId: string) => Promise<string | null>;
  now?: () => Date;
  chunkSize?: number;
  paused?: (tenantId: string) => Promise<boolean>;
  globalStop?: () => Promise<GlobalBulkStop>;
};

export function abuseReason(c: Pick<SendCounts, "sent" | "complaints" | "hard_bounces">): string | null {
  if (c.complaints >= ABUSE_COMPLAINTS_ANY) return "abuse_complaints";
  if (c.sent < ABUSE_MIN_SENT || c.sent === 0) return null;
  if (c.complaints / c.sent >= ABUSE_COMPLAINT_RATE) return "abuse_complaints";
  if (c.hard_bounces / c.sent >= ABUSE_HARD_BOUNCE_RATE) return "abuse_bounces";
  return null;
}

async function shutOffLogged(deps: FanoutDeps, tenantId: string, sendId: string, reason: string): Promise<void> {
  try {
    await deps.shutOff(tenantId, sendId, reason);
  } catch (e) {
    await logEvent({
      level: "error",
      source: "bulk-email",
      code: "bulk_email.shutoff_failed",
      message: `bulk email shutoff did not complete (${reason}); the workspace abuse hold still stops sending`,
      tenant_id: tenantId,
      meta: { bulk_send_id: sendId, reason, error_class: (e as Error)?.name ?? "Error" },
    }).catch(() => undefined);
  }
}

async function releaseUnsent(deps: FanoutDeps, tenantId: string, sendId: string, contactId: string): Promise<void> {
  const requeued = await deps.store.requeueClaimed(tenantId, sendId, contactId).then((ok) => ok, () => null);
  if (requeued !== null) return;
  await logEvent({
    level: "error",
    source: "bulk-email",
    code: "bulk_email.claim_release_failed",
    message: "a claimed recipient who was not emailed could not be put back to waiting; the row stays sending",
    tenant_id: tenantId,
    meta: { bulk_send_id: sendId },
  }).catch(() => undefined);
}

export function nextSendingDay(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0));
  return d.toISOString();
}

function stateOf(counts: SendCounts, fallback: BulkSendState): BulkSendState {
  if (counts.status === "held") return "held";
  if (counts.status === "done") return "done";
  if (counts.status === "failed") return "failed";
  return fallback;
}

export async function runBulkChunk(args: { tenantId: string; sendId: string }, deps: FanoutDeps): Promise<ChunkResult> {
  const { store } = deps;
  const { tenantId, sendId } = args;
  const now = deps.now ? deps.now() : new Date();

  const send: BulkSendRow | null = await store.getSend(tenantId, sendId);
  if (!send) return { state: "missing" };
  await store.markStaleUnknown(tenantId, sendId, STALE_SENDING_SECONDS);
  if (send.status === "done" || send.status === "failed" || send.status === "held") {
    const counts = await store.settleSend(tenantId, sendId, null);
    return { state: stateOf(counts, "done"), counts };
  }

  if (deps.paused) {
    const paused = await deps.paused(tenantId).then((p) => p, () => null);
    if (paused === null) {
      const counts = await store.settleSend(tenantId, sendId, null);
      return { state: stateOf(counts, send.status === "waiting_for_tomorrow" ? "waiting_for_tomorrow" : "more"), counts };
    }
    if (paused) {
      const counts = await store.settleSend(tenantId, sendId, "held", "email_paused");
      return { state: stateOf(counts, "held"), counts };
    }
  }

  const ready = await deps.checkReady(tenantId, send.list_id, send.list_version_id);
  if (!ready.ok) {
    const counts = await store.settleSend(tenantId, sendId, "held", ready.code);
    return { state: stateOf(counts, "held"), counts };
  }
  if (ready.sender.from_address.toLowerCase() !== send.from_address.toLowerCase()) {
    const counts = await store.settleSend(tenantId, sendId, "held", "sending_domain_changed");
    return { state: stateOf(counts, "held"), counts };
  }

  const before = await store.settleSend(tenantId, sendId, null);
  const abuseBefore = abuseReason(before);
  if (abuseBefore) {
    const counts = await store.settleSend(tenantId, sendId, "held", abuseBefore);
    await shutOffLogged(deps, tenantId, sendId, abuseBefore);
    return { state: stateOf(counts, "held"), counts };
  }

  await store.settleSend(tenantId, sendId, "sending");
  const limit = deps.chunkSize ?? BULK_CHUNK_SIZE;

  let attempted = 0;
  let exhausted = false;
  let drained = false;
  let stopAll: { status: number } | null = null;
  let throttled = false;
  let dayIndex = 0;
  let pausedNow: boolean | null = false;
  let stopNow: GlobalBulkStop = "running";
  for (let i = 0; i < send.total + 1 && attempted < limit; i += 1) {
    const claim = await guardBulkSend(store, { tenantId, sendId });
    if (claim.outcome === "held") break;
    if (claim.outcome === "none_pending") {
      drained = true;
      break;
    }
    if (claim.outcome === "allowance_exhausted") {
      dayIndex = claim.day_index;
      exhausted = true;
      break;
    }
    if (claim.outcome === "skipped") continue;
    dayIndex = claim.day_index;

    let unsubToken: string;
    let blocked: string | null;
    try {
      unsubToken = await deps.unsubToken(tenantId, claim.email);
      blocked = await store.skipIfBlocked(tenantId, sendId, claim.contact_id);
    } catch {
      await store.requeueClaimed(tenantId, sendId, claim.contact_id).catch(() => undefined);
      throttled = true;
      break;
    }
    if (blocked) continue;

    if (deps.paused || deps.globalStop) {
      if (deps.globalStop) stopNow = await deps.globalStop().then((g) => g, (): GlobalBulkStop => "unreadable");
      if (stopNow === "running" && deps.paused) pausedNow = await deps.paused(tenantId).then((p) => p, () => null);
      if (stopNow !== "running" || pausedNow !== false) {
        await releaseUnsent(deps, tenantId, sendId, claim.contact_id);
        break;
      }
    }

    attempted += 1;
    let result: BulkWireResult;
    try {
      result = await deps.wire({
        tenantId,
        sendId,
        to: claim.email,
        from: { email: send.from_address, name: ready.sender.from_name },
        replyTo: send.reply_to,
        subject: send.subject,
        bodyText: send.body_text,
        bodyHtml: send.body_html ?? null,
        unsubToken,
        postalAddress: ready.postal_address,
      });
    } catch {
      result = { kind: "unknown" };
    }
    if (result.kind === "throttled") {
      await store.requeueClaimed(tenantId, sendId, claim.contact_id).catch(() => undefined);
      throttled = true;
      break;
    }
    if (result.kind === "stop_all") {
      await store.requeueClaimed(tenantId, sendId, claim.contact_id).catch(() => undefined);
      stopAll = { status: result.status };
      break;
    }
    const status = result.kind === "sent" ? "sent" : result.kind === "unknown" ? "unknown" : "failed";
    try {
      await store.settleRecipient(tenantId, sendId, claim.contact_id, status);
    } catch {
    }
  }

  let counts: SendCounts;
  if (stopAll) {
    if (stopAll.status === 403) {
      await deps.unverifyDomain(tenantId).catch(() => undefined);
      counts = await store.settleSend(tenantId, sendId, "held", "sending_address_not_verified");
    } else {
      counts = await store.settleSend(tenantId, sendId, "held", "provider_refused");
    }
    return { state: stateOf(counts, "held"), counts };
  }

  if (stopNow === "stopped") {
    counts = await store.settleSend(tenantId, sendId, "held", "bulk_sending_paused");
    return { state: stateOf(counts, "held"), counts };
  }
  if (pausedNow === true) {
    counts = await store.settleSend(tenantId, sendId, "held", "email_paused");
    return { state: stateOf(counts, "held"), counts };
  }
  counts = await store.settleSend(tenantId, sendId, null);
  if (pausedNow === null || stopNow === "unreadable") return { state: stateOf(counts, "more"), counts };
  const abuse = abuseReason(counts);
  if (abuse && counts.status !== "done" && counts.status !== "failed") {
    counts = await store.settleSend(tenantId, sendId, "held", abuse);
    await shutOffLogged(deps, tenantId, sendId, abuse);
    return { state: stateOf(counts, "held"), counts };
  }
  if (counts.status === "held") return { state: "held", counts };
  if (throttled) return { state: "more", counts, throttled: true };

  if (exhausted) {
    counts = await store.settleSend(tenantId, sendId, "waiting_for_tomorrow", null, nextSendingDay(now));
    return {
      state: stateOf(counts, "waiting_for_tomorrow"),
      counts,
      days_left: daysToFinish(counts.pending, dayIndex),
      warming_up: warmUpIsTheLimit(dayIndex),
    };
  }
  if (drained || counts.pending === 0) {
    if (counts.sending > 0) return { state: "more", counts };
    const nothingWentOut = counts.sent === 0 && counts.unknown === 0 && counts.failed > 0;
    counts = await store.settleSend(tenantId, sendId, nothingWentOut ? "failed" : "done");
    return { state: stateOf(counts, nothingWentOut ? "failed" : "done"), counts };
  }
  return { state: "more", counts };
}

export async function defaultFanoutDeps(): Promise<FanoutDeps> {
  const [{ supabaseBulkSendStore }, { sendBulkEmail }, { getOrCreateUnsubToken }, { shutOffBulkEmail }, { markSendingDomainUnverified }, { resolveBulkReplyTo }, { emailSendPaused }, { readGlobalBulkStop }] =
    await Promise.all([
      import("./store"),
      import("./wire"),
      import("@/services/tools/email/safety-net"),
      import("./shutoff"),
      import("./sending-domain"),
      import("./reply-to"),
      import("@/services/email-cards/pause"),
      import("./config"),
    ]);
  return {
    store: supabaseBulkSendStore,
    wire: (msg) => sendBulkEmail(msg),
    checkReady: checkBulkReady,
    unsubToken: getOrCreateUnsubToken,
    shutOff: shutOffBulkEmail,
    unverifyDomain: markSendingDomainUnverified,
    replyTo: resolveBulkReplyTo,
    paused: emailSendPaused,
    globalStop: readGlobalBulkStop,
  };
}
