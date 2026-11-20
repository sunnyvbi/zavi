
import { globalClient } from "@/services/tenant-client";
import { generatePublicId, PUBLIC_ID_RE } from "@/services/start-card/store";
import type { EnrichmentResult } from "./scan";

export type ScanStatus = "queued" | "running" | "done" | "failed";
const TABLE = "onboarding_scans";

export function isScanTerminal(status: string | null | undefined): boolean {
  return status === "done" || status === "failed";
}

export async function createScan(host: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const public_id = generatePublicId();
    const { error } = await globalClient().from(TABLE).insert({ public_id, host, status: "queued" });
    if (!error) return public_id;
    if ((error as { code?: string }).code !== "23505" || attempt === 1) {
      throw new Error(`onboarding_scans insert failed: ${error.message}`);
    }
  }
  throw new Error("onboarding_scans insert failed");
}

export async function getScanPublic(publicId: string): Promise<{ status: ScanStatus; host: string } | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const { data, error } = await globalClient()
    .from(TABLE)
    .select("status, host, expires_at")
    .eq("public_id", publicId)
    .maybeSingle();
  if (error) throw new Error(`onboarding_scans read failed: ${error.message}`);
  const row = data as { status: ScanStatus; host: string; expires_at: string } | null;
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return { status: row.status, host: row.host };
}

export async function markScanFailed(publicId: string): Promise<void> {
  const { error } = await globalClient()
    .from(TABLE)
    .update({ status: "failed", finished_at: new Date().toISOString() })
    .eq("public_id", publicId)
    .neq("status", "done");
  if (error) throw new Error(`onboarding_scans fail-mark failed: ${error.message}`);
}

export async function startScan(publicId: string): Promise<{ host: string } | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const { data, error } = await globalClient()
    .from(TABLE)
    .select("host, status, expires_at")
    .eq("public_id", publicId)
    .maybeSingle();
  if (error) throw new Error(`onboarding_scans read failed: ${error.message}`);
  const row = data as { host: string; status: ScanStatus; expires_at: string } | null;
  if (!row || isScanTerminal(row.status) || Date.parse(row.expires_at) <= Date.now()) return null;
  if (row.status === "queued") {
    const { error: upErr } = await globalClient()
      .from(TABLE)
      .update({ status: "running" })
      .eq("public_id", publicId)
      .eq("status", "queued");
    if (upErr) throw new Error(`onboarding_scans start failed: ${upErr.message}`);
  }
  return { host: row.host };
}

export async function finishScan(publicId: string, enrichment: EnrichmentResult): Promise<void> {
  const { error } = await globalClient()
    .from(TABLE)
    .update({ status: "done", enrichment, finished_at: new Date().toISOString() })
    .eq("public_id", publicId)
    .in("status", ["queued", "running"]);
  if (error) throw new Error(`onboarding_scans finish failed: ${error.message}`);
}

export async function claimScan(publicId: string, host: string, userId: string): Promise<string | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const { data, error } = await globalClient()
    .from(TABLE)
    .update({ claimed_by: userId })
    .eq("public_id", publicId)
    .eq("host", host)
    .gt("expires_at", new Date().toISOString())
    .or(`claimed_by.is.null,claimed_by.eq.${userId}`)
    .select("public_id");
  if (error) throw new Error(`onboarding_scans claim failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ public_id: string }>;
  return rows.length > 0 ? rows[0].public_id : null;
}

export async function readClaimedScan(
  publicId: string,
  userId: string,
): Promise<{ status: ScanStatus; enrichment: EnrichmentResult | null } | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const { data, error } = await globalClient()
    .from(TABLE)
    .select("status, enrichment")
    .eq("public_id", publicId)
    .eq("claimed_by", userId)
    .maybeSingle();
  if (error) throw new Error(`onboarding_scans read failed: ${error.message}`);
  const row = data as { status: ScanStatus; enrichment: EnrichmentResult | null } | null;
  return row ? { status: row.status, enrichment: row.enrichment ?? null } : null;
}

export async function saveInlineScan(host: string, userId: string, enrichment: EnrichmentResult): Promise<string> {
  const public_id = generatePublicId();
  const { error } = await globalClient().from(TABLE).insert({
    public_id,
    host,
    status: "done",
    enrichment,
    claimed_by: userId,
    finished_at: new Date().toISOString(),
  });
  if (error) throw new Error(`onboarding_scans inline insert failed: ${error.message}`);
  return public_id;
}

export async function purgeExpiredScans(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await globalClient()
    .from(TABLE)
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  if (error) throw new Error(`onboarding_scans purge failed: ${error.message}`);
  return count ?? 0;
}
