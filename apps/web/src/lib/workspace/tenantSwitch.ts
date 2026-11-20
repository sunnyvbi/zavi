import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { clearActiveTenantCache } from "@/lib/active-tenant-client";
import { writeStoredTenant } from "@/lib/browser-tenant";
import { refreshSessionUntilClaim } from "@/lib/ensure-tenant-claim";
import { reloadWithoutBuild } from "./buildLinkOnLoad";

export const TENANT_SWITCH_EVENT = "zavi:tenant-switch-start";

export function announceTenantSwitch(): void {
  window.dispatchEvent(new Event(TENANT_SWITCH_EVENT));
}

const TENANT_SWITCHED_CHANNEL = "zavi:tenant-switched";
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function broadcastTenantSwitched(tenantId: string): void {
  if (typeof window === "undefined") return;
  const message = { from: TAB_ID, tenantId, at: Date.now() };
  if (typeof BroadcastChannel !== "undefined" && postToChannel(message)) return;
  try {
    window.localStorage.setItem(TENANT_SWITCHED_CHANNEL, JSON.stringify(message));
  } catch {
    return;
  }
}

function postToChannel(message: unknown): boolean {
  try {
    const channel = new BroadcastChannel(TENANT_SWITCHED_CHANNEL);
    channel.postMessage(message);
    channel.close();
    return true;
  } catch {
    return false;
  }
}

export const TENANT_SWITCHED_ELSEWHERE_EVENT = "zavi:tenant-switched-elsewhere";

const reloadHolds = new Set<symbol>();
let switchedElsewhere = false;

export function tenantSwitchedElsewhere(): boolean {
  return switchedElsewhere;
}

export function holdReloadForUnsavedWork(): () => void {
  const hold = Symbol("unsaved");
  reloadHolds.add(hold);
  return () => {
    if (!reloadHolds.delete(hold)) return;
    if (switchedElsewhere && reloadHolds.size === 0) reloadWithoutBuild();
  };
}

export function reloadUnlessUnsavedWork(): void {
  switchedElsewhere = true;
  if (reloadHolds.size === 0) {
    reloadWithoutBuild();
    return;
  }
  window.dispatchEvent(new Event(TENANT_SWITCHED_ELSEWHERE_EVENT));
}

export function listenForTenantSwitches(onSwitch: () => void = reloadUnlessUnsavedWork): () => void {
  if (typeof window === "undefined") return () => {};
  let fired = false;
  const handle = (data: unknown) => {
    if (fired || !data || typeof data !== "object") return;
    if ((data as { from?: unknown }).from === TAB_ID) return;
    fired = true;
    onSwitch();
  };
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(TENANT_SWITCHED_CHANNEL);
      channel.onmessage = (e: MessageEvent) => handle(e.data);
    } catch {
      channel = null;
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key !== TENANT_SWITCHED_CHANNEL || !e.newValue) return;
    try {
      handle(JSON.parse(e.newValue));
    } catch {
      return;
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}

export async function switchToTenant(tenantId: string): Promise<boolean> {
  return (await switchToTenantDetailed(tenantId)) === "ok";
}

export async function switchToTenantDetailed(tenantId: string): Promise<"ok" | "refused" | "not_converged"> {
  announceTenantSwitch();
  let result: "ok" | "refused" | "not_converged";
  try {
    result = await runTenantSwitch(tenantId);
  } catch (e) {
    broadcastTenantSwitched(tenantId);
    throw e;
  }
  if (result !== "refused") broadcastTenantSwitched(tenantId);
  return result;
}

async function runTenantSwitch(tenantId: string): Promise<"ok" | "refused" | "not_converged"> {
  const res = await apiFetch("/api/v1/tenants/switch", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  if (res.status === 400 || res.status === 403) return "refused";
  if (!res.ok) return "not_converged";
  await writeStoredTenant(createBrowserSupabase(), tenantId);
  const claimConverged = await refreshSessionUntilClaim(createBrowserSupabase(), tenantId);
  if (!claimConverged) return "not_converged";
  clearActiveTenantCache();
  return "ok";
}
