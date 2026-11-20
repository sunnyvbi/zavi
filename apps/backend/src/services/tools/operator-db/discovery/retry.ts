
import { inngest } from "@/../workers/client";
import type { ResolvedCatalog } from "../catalog";

const REDISCOVER_COOLDOWN_MS = 15 * 60 * 1000;

const ENQUEUE_DEDUP_MS = 60_000;
const ENQUEUE_BUCKET_MS = 5 * 60 * 1000;

const recentlyEnqueued = new Map<string, number>();

function isReady(c: ResolvedCatalog | null): boolean {
  return !!c && !c.discovery_error && (c.catalog.tables?.length ?? 0) > 0;
}

function eligible(current: ResolvedCatalog | null): boolean {
  if (isReady(current)) return false;
  if (current?.updated_at) {
    const age = Date.now() - new Date(current.updated_at).getTime();
    if (Number.isFinite(age) && age < REDISCOVER_COOLDOWN_MS) return false;
  }
  return true;
}

async function enqueueDiscovery(tenantId: string): Promise<void> {
  const now = Date.now();
  const last = recentlyEnqueued.get(tenantId);
  if (last !== undefined && now - last < ENQUEUE_DEDUP_MS) return;
  recentlyEnqueued.set(tenantId, now);
  try {
    await inngest.send({
      name: "operator-db.discover.requested",
      data: { tenant_id: tenantId },
      id: `operator-db-discover:${tenantId}:${Math.floor(now / ENQUEUE_BUCKET_MS)}`,
    });
  } catch {
    recentlyEnqueued.delete(tenantId);
  }
}

export async function maybeRediscoverCatalog(
  tenantId: string,
  current: ResolvedCatalog | null,
): Promise<ResolvedCatalog | null> {
  if (!eligible(current)) return current;
  await enqueueDiscovery(tenantId);
  return current;
}

export function rediscoveryRequestedRecently(tenantId: string, now: number = Date.now()): boolean {
  const last = recentlyEnqueued.get(tenantId);
  return last !== undefined && now - last < ENQUEUE_BUCKET_MS;
}

export function __resetRediscoverInflight(): void {
  recentlyEnqueued.clear();
}
