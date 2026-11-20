
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export const BEST_OF_N_MAX = 5;
export const BEST_OF_N_DEFAULT = 3;

export interface BestOfNPolicy {
  enabled: boolean;
  n: number;
  nightlyMaxCandidates: number;
  concurrency: number;
  kill: boolean;
}

export const BEST_OF_N_OFF: BestOfNPolicy = {
  enabled: false,
  n: 1,
  nightlyMaxCandidates: 0,
  concurrency: 0,
  kill: false,
};

function clampN(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return BEST_OF_N_DEFAULT;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > BEST_OF_N_MAX) return BEST_OF_N_MAX;
  return i;
}

function nonNegInt(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export async function resolveBestOfNPolicy(sb?: Sb): Promise<BestOfNPolicy> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return BEST_OF_N_OFF;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const cfg = (blob.best_of_n ?? {}) as Record<string, unknown>;
    if (cfg.enabled !== true) return BEST_OF_N_OFF;
    return {
      enabled: true,
      n: clampN(cfg.n),
      nightlyMaxCandidates: nonNegInt(cfg.nightly_max_candidates),
      concurrency: nonNegInt(cfg.concurrency),
      kill: cfg.kill === true,
    };
  } catch {
    return BEST_OF_N_OFF;
  }
}
