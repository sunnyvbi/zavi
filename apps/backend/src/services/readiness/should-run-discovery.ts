
export type DiscoveryScanInput = {
  score: number;
  last_discovery_at: string | null;
  newest_signal_at: string | null;
};

export type DiscoveryScanDecision = {
  run: boolean;
  reason: string;
};

export const READINESS_OPERABLE = 70;

export function shouldRunDiscovery(input: DiscoveryScanInput): DiscoveryScanDecision {
  if (input.score >= READINESS_OPERABLE) {
    return { run: false, reason: `operable (${input.score} >= ${READINESS_OPERABLE})` };
  }

  if (!input.last_discovery_at) {
    return { run: true, reason: "discovery has never run for this tenant" };
  }

  const last = Date.parse(input.last_discovery_at);
  const signal = input.newest_signal_at ? Date.parse(input.newest_signal_at) : NaN;

  if (Number.isFinite(signal) && signal > last) {
    return {
      run: true,
      reason: "a new human signal (product URL or connector) landed since the last discovery",
    };
  }

  return {
    run: false,
    reason:
      `parked: discovery already ran and nothing new has landed since. The remaining gap is ` +
      `human-gated (connectors / a measurable goal / founder engagement) — it belongs to the ` +
      `FDE, not to a retry.`,
  };
}
