
import { CHANNELS, CONNECTOR_FREE_TOOLS } from "@zavi/shared";
import { loadChannelRecipe, recipeExists } from "./recipe";
import type { WatchVerdict } from "./watch";

const HOUR = 3_600_000;

export function dueAfterMs(cadence: string): number | null {
  switch (cadence) {
    case "daily":
      return 20 * HOUR;
    case "weekly":
      return 7 * 24 * HOUR;
    case "monthly":
      return 28 * 24 * HOUR;
    default:
      return null;
  }
}

export type ChannelState = {
  channel_slug: string;
  last_run_at: string | null;
  priority: number;
  plan_selected?: boolean;
  plan_sort_order?: number | null;
  founder_stopped?: boolean;
  autorun?: boolean;
  last_probe_delta?: WatchVerdict | null;
};

export function tripMagnitude(delta: WatchVerdict | null | undefined): number {
  if (!delta || delta.verdict !== "changed") return 0;
  let max = 0;
  for (const sig of delta.signals ?? []) {
    if (!sig.tripped || typeof sig.delta !== "number" || !Number.isFinite(sig.delta)) continue;
    const abs = Math.abs(sig.delta);
    if (abs > max) max = abs;
  }
  return max;
}

export const DRAFTS_WITHOUT_CONNECTOR: ReadonlySet<string> = new Set(["x_organic"]);

export function readsPublicEvidence(tools: readonly string[]): boolean {
  const free = CONNECTOR_FREE_TOOLS as readonly string[];
  return tools.some((t) => free.includes(t));
}

export function channelsDue(
  states: readonly ChannelState[],
  linkedConnectors: ReadonlySet<string>,
  now: number,
  limit: number,
  hasPublicSite = false,
  hasLivePlan = false,
  locked: ReadonlySet<string> = new Set(),
  tierAllows: (executorSlug: string) => boolean = () => true,
): string[] {
  const bySlug = new Map(states.map((s) => [s.channel_slug, s]));
  const due: Array<{ slug: string; overdueBy: number; priority: number; trip: number }> = [];

  for (const ch of CHANNELS) {
    if (!recipeExists(ch.slug)) continue;
    if (locked.has(ch.slug)) continue;
    if (!tierAllows(ch.executor)) continue;

    const hasConnector = ch.connectors.some((c) => linkedConnectors.has(c));
    const publicPath = readsPublicEvidence(ch.tools) && hasPublicSite;
    const draftsUnconnected = DRAFTS_WITHOUT_CONNECTOR.has(ch.slug) && hasPublicSite;
    if (!hasConnector && !publicPath && !draftsUnconnected) continue;

    let cadence: string;
    try {
      cadence = loadChannelRecipe(ch.slug).meta.cadence;
    } catch {
      continue;
    }
    const after = dueAfterMs(cadence);
    if (after === null) continue;

    const state = bySlug.get(ch.slug);
    if (state?.founder_stopped) continue;

    if (hasLivePlan && !(state?.plan_selected && state?.autorun)) continue;
    if (!hasLivePlan && state?.autorun === false) continue;
    if ((ch as { plan_only?: boolean }).plan_only && !hasLivePlan) continue;

    const last = state?.last_run_at ? Date.parse(state.last_run_at) : null;
    const overdueBy = last === null ? Number.MAX_SAFE_INTEGER : now - last - after;
    if (overdueBy < 0) continue;

    due.push({
      slug: ch.slug,
      overdueBy,
      priority: state?.plan_sort_order ?? state?.priority ?? 100,
      trip: tripMagnitude(state?.last_probe_delta),
    });
  }

  due.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.trip - a.trip ||
      b.overdueBy - a.overdueBy ||
      a.slug.localeCompare(b.slug),
  );
  return due.slice(0, limit).map((d) => d.slug);
}
