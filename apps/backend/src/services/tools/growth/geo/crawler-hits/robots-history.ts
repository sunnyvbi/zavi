
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { CrawlerAccess } from "../analyze";

export type RobotsObservation = {
  bot: string;
  state: "allowed" | "blocked" | "partial";
  directive: string | null;
  observed_at: string;
};

export function changedVerdicts(
  crawlers: readonly CrawlerAccess[],
  latestByBot: ReadonlyMap<string, string>,
): Array<{ bot: string; state: "allowed" | "blocked" | "partial"; directive: string | null }> {
  return crawlers
    .filter((c): c is CrawlerAccess & { state: "allowed" | "blocked" | "partial" } => c.state !== "unknown")
    .filter((c) => latestByBot.get(c.name) !== c.state)
    .map((c) => ({ bot: c.name, state: c.state, directive: c.directive }));
}

export async function recordRobotsObservations(
  tenantId: string,
  crawlers: readonly CrawlerAccess[],
): Promise<void> {
  try {
    if (crawlers.every((c) => c.state === "unknown")) return;
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db
      .from("geo_robots_observations")
      .select("bot, state, observed_at")
      .order("observed_at", { ascending: false })
      .limit(500);
    if (error) return;
    const latest = new Map<string, string>();
    for (const r of (data ?? []) as Array<{ bot: string; state: string }>) {
      if (!latest.has(r.bot)) latest.set(r.bot, r.state);
    }
    const changed = changedVerdicts(crawlers, latest);
    if (changed.length === 0) return;
    const now = new Date().toISOString();
    await db
      .from("geo_robots_observations")
      .insert(changed.map((c) => ({ ...c, directive: c.directive?.slice(0, 500) ?? null, observed_at: now })));
  } catch {
  }
}

export async function readRobotsHistory(
  tenantId: string,
): Promise<Map<string, { current: RobotsObservation; previous: RobotsObservation | null }>> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("geo_robots_observations")
    .select("bot, state, directive, observed_at")
    .order("observed_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`geo robots history read failed: ${error.message}`);
  const out = new Map<string, { current: RobotsObservation; previous: RobotsObservation | null }>();
  for (const r of (data ?? []) as RobotsObservation[]) {
    const cur = out.get(r.bot);
    if (!cur) out.set(r.bot, { current: r, previous: null });
    else if (!cur.previous) cur.previous = r;
  }
  return out;
}
