import { createHash } from "node:crypto";
import { globalClient, startCardRpc } from "@/services/tenant-client";

export const canonicalDomain = (d: string) => d.trim().toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

export type ManifestItem = { domain: string; source: "product_hunt" | "yc" };

export function manifestHash(items: ManifestItem[]): string {
  const lines = items.map((i) => `${canonicalDomain(i.domain)}\t${i.source}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function createRun(input: {
  manifest_hash: string;
  pipeline_version: string;
  privacy_version: string;
  spend_cap_usd: number;
}): Promise<string> {
  const { data, error } = await globalClient().from("seed_runs").insert(input).select("id").single<{ id: string }>();
  if (error || !data) throw new Error(`seed run create failed: ${error?.message ?? "no row"}`);
  return data.id;
}

export async function getRun(id: string): Promise<{ id: string; manifest_hash: string; status: string; spent_usd: number; spend_cap_usd: number } | null> {
  const { data, error } = await globalClient()
    .from("seed_runs")
    .select("id, manifest_hash, status, spent_usd, spend_cap_usd")
    .eq("id", id)
    .maybeSingle<{ id: string; manifest_hash: string; status: string; spent_usd: number; spend_cap_usd: number }>();
  if (error) throw new Error(`seed run read failed: ${error.message}`);
  return data ?? null;
}

export async function addItems(runId: string, items: ManifestItem[]): Promise<void> {
  const rows = items.map((i) => ({ run_id: runId, domain: canonicalDomain(i.domain), source: i.source }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await globalClient()
      .from("seed_run_items")
      .upsert(rows.slice(i, i + 500), { onConflict: "run_id,domain", ignoreDuplicates: true });
    if (error) throw new Error(`seed items insert failed: ${error.message}`);
  }
}

export async function pendingItems(runId: string, limit: number): Promise<Array<{ domain: string; state: string; attempts: number; card_id: string | null }>> {
  const { data, error } = await globalClient()
    .from("seed_run_items")
    .select("domain, state, attempts, card_id")
    .eq("run_id", runId)
    .in("state", ["pending", "running"])
    .order("domain")
    .limit(limit);
  if (error) throw new Error(`seed items read failed: ${error.message}`);
  return (data ?? []) as Array<{ domain: string; state: string; attempts: number; card_id: string | null }>;
}

export async function setItem(runId: string, domain: string, patch: { state: string; card_id?: string | null; reason?: string | null; attempts?: number }): Promise<void> {
  const { error } = await globalClient()
    .from("seed_run_items")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("domain", domain);
  if (error) throw new Error(`seed item update failed: ${error.message}`);
}

export async function takeLease(runId: string, holder: string, ttlMs: number, now: Date = new Date()): Promise<boolean> {
  const until = new Date(now.getTime() + ttlMs).toISOString();
  const { data, error } = await globalClient()
    .from("seed_runs")
    .update({ lease_holder: holder, lease_until: until, updated_at: now.toISOString() })
    .eq("id", runId)
    .eq("status", "open")
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()},lease_holder.eq.${holder}`)
    .select("id");
  if (error) throw new Error(`seed lease failed: ${error.message}`);
  return (data ?? []).length === 1;
}

export async function releaseLease(runId: string, holder: string): Promise<void> {
  await globalClient().from("seed_runs").update({ lease_holder: null, lease_until: null }).eq("id", runId).eq("lease_holder", holder);
}

export type ReserveOutcome = "reserved" | "already_reserved" | "settled" | "cap_reached";

export async function reserve(runId: string, domain: string, usd: number): Promise<ReserveOutcome> {
  const { data, error } = await startCardRpc("seed_run_reserve", { p_run_id: runId, p_domain: domain, p_usd: usd });
  if (error) throw new Error(`seed reserve failed: ${error.message}`);
  const o = (data as { outcome?: string } | null)?.outcome;
  if (o === "reserved" || o === "already_reserved" || o === "settled" || o === "cap_reached") return o;
  throw new Error(`seed reserve returned ${String(o)}`);
}

export async function settle(runId: string, domain: string, actualUsd: number): Promise<void> {
  const { error } = await startCardRpc("seed_run_settle", { p_run_id: runId, p_domain: domain, p_actual_usd: Math.max(0, actualUsd) });
  if (error) throw new Error(`seed settle failed: ${error.message}`);
}
