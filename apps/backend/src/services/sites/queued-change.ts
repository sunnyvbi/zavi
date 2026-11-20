import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

export type QueueOutcome = "queued" | "replaced" | "busy";

export type QueuedChange = { site_id: string; conductor_run_id: string; message: string };

export type DrainOutcome =
  | { kind: "empty" }
  | { kind: "started"; site_id: string; conductor_run_id: string }
  | { kind: "still_busy"; site_id: string }
  | { kind: "failed"; site_id: string; code: string };

export const QUEUED_CHANGE_CHAT = "Your site is still building. I'll make this change as soon as it finishes.";
export const REPLACED_CHANGE_CHAT =
  "Your site is still building. I'll make this change as soon as it finishes, instead of the one I was holding.";

export const QUEUED_CHANGE_STARTED_CHAT = "Your site finished building. I'm making the change you asked for now.";
export const QUEUED_CHANGE_FAILED_CHAT = "Your site finished building, but I couldn't start the change you asked for. Send it again and I'll try.";
export const QUEUED_CHANGE_DROPPED_CHAT = "Your site's build didn't finish, so I didn't make the change you asked for. Send it again once the site is working.";

export type QueuedChangeStore = {
  queue: (input: { tenant_id: string; site_id: string; conductor_run_id: string; message: string; user_id: string | null }) => Promise<QueueOutcome>;
  claim: (tenant_id: string) => Promise<QueuedChange | null>;
  settle: (tenant_id: string, site_id: string, requeue: boolean) => Promise<void>;
  dropStopped: (tenant_id: string) => Promise<string[]>;
};

export type DrainDeps = {
  store: QueuedChangeStore;
  refine: (input: { tenant_id: string; message: string; conductor_run_id: string }) => Promise<{ conductor_run_id: string }>;
  tick: (conductor_run_id: string) => Promise<unknown>;
  isBusy: (e: unknown) => boolean;
  notify: (tenant_id: string, conductor_run_id: string, body: string) => Promise<unknown>;
  failureChat?: (e: unknown) => string | null;
};

export const realQueuedChangeStore: QueuedChangeStore = {
  async queue({ tenant_id, site_id, conductor_run_id, message, user_id }) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_queue_change", {
      p_site_id: site_id,
      p_conductor_run_id: conductor_run_id,
      p_message: message,
      p_user_id: user_id,
    });
    if (error) throw new Error(`site_queue_change failed: ${error.message}`);
    if (data !== "queued" && data !== "replaced" && data !== "busy") throw new Error(`site_queue_change returned ${String(data)}`);
    return data;
  },
  async claim(tenant_id) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_claim_queued_change", {});
    if (error) throw new Error(`site_claim_queued_change failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as QueuedChange | null | undefined;
    return row?.site_id ? row : null;
  },
  async settle(tenant_id, site_id, requeue) {
    const { error } = await tenantRpc(asTenantId(tenant_id), "site_settle_queued_change", { p_site_id: site_id, p_requeue: requeue });
    if (error) throw new Error(`site_settle_queued_change failed: ${error.message}`);
  },
  async dropStopped(tenant_id) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_drop_stopped_queued_changes", {});
    if (error) throw new Error(`site_drop_stopped_queued_changes failed: ${error.message}`);
    return Array.isArray(data) ? (data as string[]) : [];
  },
};

export async function discardHeldChange(tenant_id: string, conductor_run_id: string): Promise<string[]> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_discard_queued_change", { p_conductor_run_id: conductor_run_id });
  if (error) throw new Error(`site_discard_queued_change failed: ${error.message}`);
  return Array.isArray(data) ? (data as string[]) : [];
}

export async function dropHeldChanges(tenant_id: string, conductor_run_id: string): Promise<number> {
  const sessions = await discardHeldChange(tenant_id, conductor_run_id);
  if (sessions.length === 0) return 0;
  const { postBuildChatNote } = await import("@/services/build/build-ready-message");
  await Promise.allSettled(sessions.map((session) => postBuildChatNote({ tenant_id, conductor_run_id: session, body: QUEUED_CHANGE_DROPPED_CHAT })));
  return sessions.length;
}

async function noteStoppedChanges(tenant_id: string, deps: DrainDeps): Promise<void> {
  try {
    const sessions = await deps.store.dropStopped(tenant_id);
    const notes = await Promise.allSettled(sessions.map((session) => deps.notify(tenant_id, session, QUEUED_CHANGE_DROPPED_CHAT)));
    const missed = notes.filter((note) => note.status === "rejected");
    if (missed.length > 0) throw (missed[0] as PromiseRejectedResult).reason;
    if (notes.some((note) => note.status === "fulfilled" && note.value === false)) throw new Error("No chat thread for a dropped change");
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "sites.queued_change",
      code: "queued_site_change_drop_failed",
      tenant_id,
      error: e,
    }).catch(() => undefined);
  }
}

export async function drainQueuedSiteChange(tenant_id: string, deps: DrainDeps): Promise<DrainOutcome> {
  await noteStoppedChanges(tenant_id, deps);
  const claimed = await deps.store.claim(tenant_id);
  if (!claimed) return { kind: "empty" };
  let started: { conductor_run_id: string };
  try {
    started = await deps.refine({ tenant_id, message: claimed.message, conductor_run_id: claimed.conductor_run_id });
  } catch (e) {
    if (deps.isBusy(e)) {
      await deps.store.settle(tenant_id, claimed.site_id, true);
      return { kind: "still_busy", site_id: claimed.site_id };
    }
    await deps.store.settle(tenant_id, claimed.site_id, false);
    const code = (e as Error | null)?.name || "error";
    await logEvent({
      level: "warn",
      source: "sites.queued_change",
      code: "queued_site_change_failed",
      tenant_id,
      error: e,
    }).catch(() => undefined);
    const reason = deps.failureChat?.(e) ?? null;
    await Promise.resolve(deps.notify(tenant_id, claimed.conductor_run_id, reason ? `${QUEUED_CHANGE_FAILED_CHAT} ${reason}` : QUEUED_CHANGE_FAILED_CHAT)).catch(() => undefined);
    return { kind: "failed", site_id: claimed.site_id, code };
  }
  await deps.store.settle(tenant_id, claimed.site_id, false);
  await Promise.resolve(deps.tick(started.conductor_run_id)).catch(() => undefined);
  await Promise.resolve(deps.notify(tenant_id, claimed.conductor_run_id, QUEUED_CHANGE_STARTED_CHAT)).catch(() => undefined);
  return { kind: "started", site_id: claimed.site_id, conductor_run_id: started.conductor_run_id };
}

export type HoldDeps = {
  store: QueuedChangeStore;
  drain: (tenant_id: string) => Promise<unknown>;
};

export async function holdChangeWhileBuilding(
  input: { tenant_id: string; site_id: string; conductor_run_id: string; message: string; user_id: string | null },
  deps: HoldDeps,
): Promise<string | null> {
  let outcome: QueueOutcome;
  try {
    outcome = await deps.store.queue(input);
  } catch (e) {
    await logEvent({
      level: "error",
      source: "sites.queued_change",
      code: "queued_site_change_save_failed",
      tenant_id: input.tenant_id,
      error: e,
    }).catch(() => undefined);
    return null;
  }
  if (outcome === "busy") return null;
  void Promise.resolve(deps.drain(input.tenant_id)).catch(() => undefined);
  return outcome === "replaced" ? REPLACED_CHANGE_CHAT : QUEUED_CHANGE_CHAT;
}
