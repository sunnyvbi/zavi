
export type ReadbackPlatform = "meta" | "google";

export type LiveBudgetReader = () => Promise<number | null>;

export function budgetMatches(expectedMinor: number, liveMinor: number): boolean {
  return Math.abs(expectedMinor - liveMinor) <= 1;
}

export const readbackTopic = (platform: ReadbackPlatform, object_id: string) => `budget_readback:${platform}:${object_id}`;

export function readbackAsk(a: { label: string; expected: string; live: string }): string {
  return `${a.label}: Zavi set its daily budget to ${a.expected}, but the ad account now shows ${a.live}. Should the budget be ${a.expected}, or is ${a.live} right?`;
}

export type ReadbackDeps = {
  ask: (tenant_id: string, topic: string, ask: string) => Promise<boolean>;
  log: (tenant_id: string, message: string) => void;
};

const defaultDeps: ReadbackDeps = {
  ask: async (tenant_id, topic, ask) => (await import("./open-advice")).askFounderOutsideReview({ tenant_id, topic, ask }),
  log: (tenant_id, message) => console.warn(`[budget-readback] ${tenant_id}: ${message}`),
};

export async function readBackBudget(
  a: {
    tenant_id: string;
    platform: ReadbackPlatform;
    object_id: string;
    label: string;
    expected_minor: number;
    minor_per_major: number;
    currency: string;
    read: LiveBudgetReader;
  },
  deps: ReadbackDeps = defaultDeps,
): Promise<"match" | "mismatch" | "unread"> {
  try {
    const live = await a.read();
    if (live === null || !Number.isFinite(live)) return "unread";
    if (budgetMatches(a.expected_minor, live)) return "match";
    const fmt = (minor: number) => `${(minor / a.minor_per_major).toFixed(2)} ${a.currency}/day`;
    const expected = fmt(a.expected_minor);
    const shown = fmt(live);
    deps.log(a.tenant_id, `${a.platform} ${a.object_id}: budget read back as ${shown}, set to ${expected}`);
    await deps.ask(a.tenant_id, readbackTopic(a.platform, a.object_id), readbackAsk({ label: a.label, expected, live: shown })).catch(() => false);
    return "mismatch";
  } catch (e) {
    try {
      deps.log(a.tenant_id, `${a.platform} ${a.object_id}: budget read-back failed: ${(e as Error).message}`);
    } catch {
    }
    return "unread";
  }
}
