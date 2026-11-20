import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { connectorWakeupClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

export const WAKEUP_TOPIC = "db-connector-wakeups";

type WakeupDeps = { client: () => SupabaseClient; log: typeof logEvent };
let deps: WakeupDeps = {
  client: () => connectorWakeupClient("Zavi Connector long-poll wakeups (private broadcast topic, tenant ids only)"),
  log: (i) => logEvent(i),
};

const waiters = new Map<string, Set<() => void>>();
const revokeListeners = new Set<(tenant_id: string) => void>();
let channel: RealtimeChannel | null = null;
let state: "idle" | "subscribing" | "subscribed" | "failed" = "idle";
let lastFailureLog = 0;

function wakeLocal(tenant_id: string): void {
  const set = waiters.get(tenant_id);
  if (!set) return;
  for (const fn of [...set]) fn();
}

function revokeLocal(tenant_id: string): void {
  for (const fn of revokeListeners) fn(tenant_id);
  wakeLocal(tenant_id);
}

function tenantOf(payload: unknown): string | null {
  const t = (payload as { payload?: { tenant_id?: unknown } } | null)?.payload?.tenant_id;
  return typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t) ? t : null;
}

async function logFailure(code: string, stage: string): Promise<void> {
  const now = Date.now();
  if (now - lastFailureLog < 60_000) return;
  lastFailureLog = now;
  await deps.log({ level: "warn", source: "db-connector.wakeup", code, meta: { stage } });
}

function getChannel(): RealtimeChannel {
  if (!channel) {
    channel = deps
      .client()
      .channel(WAKEUP_TOPIC, { config: { private: true, broadcast: { self: false, ack: false } } })
      .on("broadcast", { event: "wake" }, (msg) => {
        const t = tenantOf(msg);
        if (t) wakeLocal(t);
      })
      .on("broadcast", { event: "revoke" }, (msg) => {
        const t = tenantOf(msg);
        if (t) revokeLocal(t);
      });
  }
  return channel;
}

export function ensureWakeupSubscription(): void {
  if (state === "subscribing" || state === "subscribed") return;
  state = "subscribing";
  try {
    getChannel().subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state = "subscribed";
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        state = "failed";
        void logFailure("connector_wakeup_subscribe_failed", String(status).toLowerCase());
      }
    });
  } catch {
    state = "failed";
    void logFailure("connector_wakeup_subscribe_failed", "throw");
  }
}

export function waitForWake(tenant_id: string, ms: number, signal?: { aborted: boolean; onAbort: (fn: () => void) => void }): Promise<"wake" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: "wake" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = waiters.get(tenant_id);
      set?.delete(wake);
      if (set && set.size === 0) waiters.delete(tenant_id);
      resolve(r);
    };
    const wake = () => finish("wake");
    const timer = setTimeout(() => finish("timeout"), Math.max(0, ms));
    if (!waiters.has(tenant_id)) waiters.set(tenant_id, new Set());
    waiters.get(tenant_id)!.add(wake);
    if (signal) {
      if (signal.aborted) finish("timeout");
      else signal.onAbort(() => finish("timeout"));
    }
  });
}

async function broadcast(event: "wake" | "revoke", tenant_id: string): Promise<void> {
  try {
    const r = await getChannel().httpSend(event, { tenant_id }, { timeout: 2000 });
    if (!r.success) await logFailure("connector_wakeup_send_failed", `${event}_${r.status}`);
  } catch {
    await logFailure("connector_wakeup_send_failed", `${event}_throw`);
  }
}

export async function publishWake(tenant_id: string): Promise<void> {
  wakeLocal(tenant_id);
  await broadcast("wake", tenant_id);
}

export async function publishRevoke(tenant_id: string): Promise<void> {
  revokeLocal(tenant_id);
  await broadcast("revoke", tenant_id);
}

export function onRevoke(fn: (tenant_id: string) => void): () => void {
  revokeListeners.add(fn);
  return () => revokeListeners.delete(fn);
}

export function _setWakeupDepsForTests(d: Partial<WakeupDeps>): void {
  deps = { ...deps, ...d };
  channel = null;
  state = "idle";
  waiters.clear();
  lastFailureLog = 0;
}
export function _deliverForTests(event: "wake" | "revoke", tenant_id: string): void {
  if (event === "wake") wakeLocal(tenant_id);
  else revokeLocal(tenant_id);
}
export function _waiterCountForTests(tenant_id: string): number {
  return waiters.get(tenant_id)?.size ?? 0;
}
