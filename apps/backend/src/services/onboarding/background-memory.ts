
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { upsertAnchorGuarded } from "@/services/memory/upsert-anchor";
import { logEvent } from "@/services/logging/logEvent";
import { placeholderBody, type PlaceholderSlug } from "./placeholder-docs";
import { claimScan } from "./scan-store";
import { normalizeWebsiteHost } from "./website-host";
import { inngest } from "@/../workers/client";

export const MEMORY_REQUESTED_EVENT = "tenant/onboarding.memory.requested" as const;
export const SCAN_FINISHED_EVENT = "onboarding/scan.finished" as const;

export type MemoryStatus = "pending" | "ready" | "failed";
const TABLE = "tenant_onboarding_memory";
const PLACEHOLDER_SLUGS: readonly PlaceholderSlug[] = ["ops", "policies", "disputes", "support"];
export const ONBOARDING_SEED = "onboarding_seed" as const;

export type MemoryJobRow = {
  tenant_id: string;
  user_id: string;
  host: string | null;
  initial_name: string | null;
  scan_public_id: string | null;
  status: MemoryStatus;
  attempt: number;
};

export function activationHost(onboardingMeta: unknown): string | null {
  const meta = (onboardingMeta ?? {}) as Record<string, unknown>;
  const wizard = (meta.wizard ?? {}) as Record<string, unknown>;
  return normalizeWebsiteHost(wizard.website);
}

export async function seedPlaceholderDocs(tenantId: string, shape = "company"): Promise<void> {
  for (const slug of PLACEHOLDER_SLUGS) {
    try {
      await upsertAnchorGuarded(
        {
          tenant_id: tenantId,
          slug,
          body_markdown: placeholderBody(slug, shape),
          source: ONBOARDING_SEED,
          metadata: { seed: "placeholder" },
        },
        [ONBOARDING_SEED],
        { skipEmbedding: true },
      );
    } catch (e) {
      console.warn(`[onboarding/background-memory] placeholder ${slug} failed for ${tenantId}: ${(e as Error).message}`);
    }
  }
}

export async function startBackgroundMemory(args: {
  tenantId: string;
  userId: string;
  scanId: string | null;
  host: string | null;
  initialName: string;
}): Promise<{ status: MemoryStatus | "error" }> {
  const tid = asTenantId(args.tenantId);
  let claimed: string | null = null;
  if (args.scanId && args.host) {
    try {
      claimed = await claimScan(args.scanId, args.host, args.userId);
    } catch (e) {
      console.warn(`[onboarding/background-memory] scan claim failed for ${args.tenantId}: ${(e as Error).message}`);
    }
  }

  const { error: insErr } = await tenantClient(tid)
    .from(TABLE)
    .upsert(
      {
        user_id: args.userId,
        host: args.host,
        initial_name: args.initialName,
        scan_public_id: claimed,
        status: "pending",
        attempt: 0,
      },
      { onConflict: "tenant_id", ignoreDuplicates: true },
    );
  if (insErr) {
    console.warn(`[onboarding/background-memory] row insert failed for ${args.tenantId}: ${insErr.message}`);
    return { status: "error" };
  }

  await seedPlaceholderDocs(args.tenantId);

  try {
    await inngest.send({ name: MEMORY_REQUESTED_EVENT, data: { tenant_id: args.tenantId, attempt: 0 } });
  } catch (e) {
    const msg = `enqueue failed: ${(e as Error).message}`.slice(0, 500);
    await markMemoryFailed(args.tenantId, msg).catch(() => undefined);
    void logEvent({
      level: "warn",
      source: "onboarding.website_memory",
      code: "onboarding.website_memory.enqueue_failed",
      message: `memory job enqueue failed for tenant ${args.tenantId}`,
      tenant_id: args.tenantId,
    });
    return { status: "failed" };
  }
  return { status: "pending" };
}

export async function readMemoryRow(tenantId: string): Promise<MemoryJobRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from(TABLE)
    .select("tenant_id, user_id, host, initial_name, scan_public_id, status, attempt")
    .maybeSingle();
  if (error) throw new Error(`${TABLE} read failed: ${error.message}`);
  return (data as MemoryJobRow | null) ?? null;
}

export async function readMemoryStatus(tenantId: string): Promise<MemoryStatus | null> {
  const row = await readMemoryRow(tenantId);
  return row?.status ?? null;
}

export async function isTenantMember(tenantId: string, userId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("tenant_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`tenant_users read failed: ${error.message}`);
  return !!data;
}

export async function markMemoryReady(tenantId: string, fallback: boolean): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenantId))
    .from(TABLE)
    .update({ status: "ready", fallback, error: null, updated_at: new Date().toISOString() })
    .eq("status", "pending");
  if (error) throw new Error(`${TABLE} ready failed: ${error.message}`);
}

export async function markMemoryFailed(tenantId: string, message: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenantId))
    .from(TABLE)
    .update({ status: "failed", error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("status", "pending");
  if (error) throw new Error(`${TABLE} fail-mark failed: ${error.message}`);
}

export async function setMemoryScan(tenantId: string, scanPublicId: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenantId))
    .from(TABLE)
    .update({ scan_public_id: scanPublicId, updated_at: new Date().toISOString() });
  if (error) throw new Error(`${TABLE} scan update failed: ${error.message}`);
}

export async function resetMemoryForRetry(tenantId: string, current: MemoryJobRow): Promise<number | null> {
  const next = current.attempt + 1;
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from(TABLE)
    .update({
      status: "pending",
      attempt: next,
      scan_public_id: null,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "failed")
    .eq("attempt", current.attempt)
    .select("attempt");
  if (error) throw new Error(`${TABLE} retry reset failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ attempt: number }>;
  return rows.length > 0 ? rows[0].attempt : null;
}
