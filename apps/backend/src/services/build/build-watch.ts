import { asTenantId, clearTenantMarker, stampTenantMarker, tenantMarkerAt } from "@/services/tenant-client";

export const BUILD_WATCH_BUCKET = "build_watch";
export const BUILD_WATCH_FRESH_MS = 2 * 60_000;

const watchBucket = (sessionId: string) => `${BUILD_WATCH_BUCKET}:${sessionId.toLowerCase()}`;

export async function recordBuildWatch(tenantId: string, sessionId: string, now: Date = new Date()): Promise<void> {
  await stampTenantMarker(asTenantId(tenantId), watchBucket(sessionId), now);
}

export async function clearBuildWatch(tenantId: string, sessionId: string): Promise<void> {
  await clearTenantMarker(asTenantId(tenantId), watchBucket(sessionId));
}

export async function founderWatchingBuild(tenantId: string, sessionId: string, nowMs: number = Date.now()): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const at = await tenantMarkerAt(asTenantId(tenantId), watchBucket(sessionId));
    return at !== null && Math.abs(nowMs - at) < BUILD_WATCH_FRESH_MS;
  } catch {
    return false;
  }
}
