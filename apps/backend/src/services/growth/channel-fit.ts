
import { readStrategyNote } from "@/services/growth/strategy-note";

function planText(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : null;
}

const FIT_VALUES = new Set(["high", "medium", "low"]);

export async function readStrategyFit(
  tenant_id: string,
  read: typeof readStrategyNote = readStrategyNote,
): Promise<{ has_strategy: boolean; fits: ReadonlyMap<string, { value: "high" | "medium" | "low"; line: string }> }> {
  const fits = new Map<string, { value: "high" | "medium" | "low"; line: string }>();
  try {
    const note = await read(tenant_id);
    if (!note) return { has_strategy: false, fits };
    const strategy = (note.metadata as { strategy?: { channel_fit?: unknown } }).strategy;
    for (const f of Array.isArray(strategy?.channel_fit) ? strategy!.channel_fit : []) {
      const ff = (f ?? {}) as Record<string, unknown>;
      const slug = typeof ff.channel_slug === "string" ? ff.channel_slug : "";
      const value = typeof ff.value === "string" ? ff.value : "";
      const line = planText(ff.line);
      if (slug && FIT_VALUES.has(value) && line) fits.set(slug, { value: value as "high" | "medium" | "low", line });
    }
    return { has_strategy: Boolean(strategy), fits };
  } catch {
    return { has_strategy: false, fits };
  }
}

export function pinLiveBetsHigh(
  fits: ReadonlyMap<string, { value: "high" | "medium" | "low"; line: string }>,
  planBets: ReadonlyMap<string, { intent: string | null; rationale: string | null; status?: string | null }>,
): ReadonlyMap<string, { value: "high" | "medium" | "low"; line: string }> {
  if (planBets.size === 0) return fits;
  const out = new Map(fits);
  for (const [slug, bet] of planBets) {
    if (bet.status === "rejected" || bet.status === "superseded") continue;
    const line = bet.rationale ?? bet.intent ?? out.get(slug)?.line ?? null;
    if (line) out.set(slug, { value: "high", line });
  }
  return out;
}
