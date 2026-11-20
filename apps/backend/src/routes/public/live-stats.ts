
import type { Request, Response } from "express";
import { publicLiveStatsAggregate } from "@/services/tenant-client";

const CACHE_MS = 60 * 60 * 1000;
const SECONDS_PER_7D = 7 * 24 * 60 * 60;

export type PublicLiveStats = {
  as_of: string;
  metrics: {
    tokens_processed: { value: number; rate_per_sec: number };
    actions_approved: { value: number; rate_per_sec: number };
    agent_steps: { value: number; rate_per_sec: number };
  };
};

type RpcRow = {
  tokens_total: unknown;
  tokens_7d: unknown;
  actions_total: unknown;
  actions_7d: unknown;
  steps_total: unknown;
  steps_7d: unknown;
  as_of: unknown;
};

let cache: { payload: PublicLiveStats; fetchedAt: number } | null = null;
let inflight: Promise<PublicLiveStats> | null = null;

export function __resetLiveStatsCache(): void {
  cache = null;
  inflight = null;
}

function toInt(v: unknown): number {
  if (typeof v !== "number" && (typeof v !== "string" || v.trim() === "")) {
    throw new Error("bad_value");
  }
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new Error("bad_value");
  return n;
}

export function buildLiveStats(row: RpcRow): PublicLiveStats {
  const tokensTotal = toInt(row.tokens_total);
  const tokens7d = toInt(row.tokens_7d);
  const actionsTotal = toInt(row.actions_total);
  const actions7d = toInt(row.actions_7d);
  const stepsTotal = toInt(row.steps_total);
  const steps7d = toInt(row.steps_7d);
  const asOf = new Date(String(row.as_of));
  if (Number.isNaN(asOf.getTime())) throw new Error("bad_as_of");
  return {
    as_of: asOf.toISOString(),
    metrics: {
      tokens_processed: { value: tokensTotal, rate_per_sec: tokens7d / SECONDS_PER_7D },
      actions_approved: { value: actionsTotal, rate_per_sec: actions7d / SECONDS_PER_7D },
      agent_steps: { value: stepsTotal, rate_per_sec: steps7d / SECONDS_PER_7D },
    },
  };
}

async function refresh(): Promise<PublicLiveStats> {
  const { data, error } = await publicLiveStatsAggregate();
  if (error || !data) throw new Error("rpc_failed");
  const payload = buildLiveStats(data as RpcRow);
  cache = { payload, fetchedAt: Date.now() };
  return payload;
}

function sharedRefresh(): Promise<PublicLiveStats> {
  inflight ??= refresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function warmLiveStats(): void {
  sharedRefresh().catch(() => {});
}

export async function publicLiveStats(_req: Request, res: Response): Promise<void> {
  res.set("Cache-Control", "public, max-age=60");

  if (cache) {
    if (Date.now() - cache.fetchedAt >= CACHE_MS) sharedRefresh().catch(() => {});
    res.json(cache.payload);
    return;
  }

  try {
    res.json(await sharedRefresh());
  } catch {
    res.set("Cache-Control", "no-store");
    res.status(503).json({ error: { code: "unavailable" } });
  }
}
