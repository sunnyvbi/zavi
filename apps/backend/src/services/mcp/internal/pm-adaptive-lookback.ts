
import { serviceClient } from "@/services/supabase";
import { normSignature } from "@/agents/pm/signature";
import { isPmRoadmapEnabled } from "@/agents/pm/roadmap-flag";

export const THIN_CORPUS_THRESHOLD = 8;

export const EXTENDED_LOOKBACK_DAYS = 45;

export const RECENCY_FLOOR = 0.15;

export type AdaptiveRunRow = {
  id: string;
  agent_slug: string;
  status: string;
  started_at: string | null;
  enqueued_at: string;
  output_text: string | null;
  parsed: unknown;
  error: string | null;
};

export type AdaptiveLookbackMeta = {
  requested_days: number;
  effective_days: number;
  extended: boolean;
  suppressed_resolved: number;
};

export type AdaptiveRow = AdaptiveRunRow & { recency_weight: number };

export type AdaptiveLookbackResult = {
  rows: AdaptiveRow[];
  meta: AdaptiveLookbackMeta;
};

export function computeRecencyWeight(
  ageDays: number,
  requestedDays: number,
): number {
  if (!Number.isFinite(ageDays) || ageDays <= requestedDays) return 1.0;
  const halfLife = Math.max(requestedDays, 1);
  const extraAge = ageDays - requestedDays;
  const weight = Math.pow(0.5, extraAge / halfLife);
  return Math.max(RECENCY_FLOOR, Math.min(1.0, weight));
}

export async function loadResolvedSignatures(
  tenant_id: string,
): Promise<Set<string>> {
  const enabled = await isPmRoadmapEnabled();
  if (!enabled) return new Set();
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("pm_roadmap")
      .select("baseline_signature, status, outcome")
      .eq("tenant_id", tenant_id)
      .eq("status", "measured")
      .eq("outcome", "won")
      .not("baseline_signature", "is", null)
      .limit(500);
    if (error) {
      console.warn(
        `[pm adaptive-lookback] resolved-signature read failed for tenant=${tenant_id}: ${error.message}`,
      );
      return new Set();
    }
    const sigs = new Set<string>();
    for (const r of (data ?? []) as Array<{ baseline_signature: string | null }>) {
      const sig = (r.baseline_signature ?? "").trim();
      if (sig) sigs.add(sig);
    }
    return sigs;
  } catch (e) {
    console.warn(
      `[pm adaptive-lookback] resolved-signature read threw: ${(e as Error).message}`,
    );
    return new Set();
  }
}

export function applyDecayAndSuppression(
  rows: AdaptiveRunRow[],
  requestedDays: number,
  resolvedSignatures: Set<string>,
  now: number = Date.now(),
): { rows: AdaptiveRow[]; suppressed: number } {
  const out: AdaptiveRow[] = [];
  let suppressed = 0;
  const requestedCutoff = now - requestedDays * 86400 * 1000;
  for (const r of rows) {
    const tsRaw = r.enqueued_at;
    const ts = Date.parse(tsRaw);
    const inRequestedWindow = Number.isFinite(ts) ? ts >= requestedCutoff : true;

    if (!inRequestedWindow && resolvedSignatures.size > 0) {
      const sig = normSignature(r.error);
      if (sig && resolvedSignatures.has(sig)) {
        suppressed += 1;
        continue;
      }
    }

    const ageDays = Number.isFinite(ts) ? (now - ts) / (86400 * 1000) : 0;
    const recency_weight = inRequestedWindow
      ? 1.0
      : computeRecencyWeight(ageDays, requestedDays);
    out.push({ ...r, recency_weight });
  }
  return { rows: out, suppressed };
}

export function isThinCorpus(rowsSeenInWindow: number): boolean {
  return rowsSeenInWindow < THIN_CORPUS_THRESHOLD;
}
