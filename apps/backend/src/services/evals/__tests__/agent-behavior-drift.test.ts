import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

const driftUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../eval/agent-behavior/_BUILD/drift-check.mjs"),
).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let detectSpikes: (b: any, c: any, t: number, o?: any) => any[];
beforeAll(async () => {
  ({ detectSpikes } = await import(driftUrl));
});

const baseline = {
  "format:schema-parse-failure": { rate_pct: 2.59 },
  "connector-wall:connect-action-marker": { rate_pct: 1.45 },
};

describe("agent-behavior drift canary", () => {
  it("FIRES when a rule spikes well above baseline", () => {
    const spikes = detectSpikes(baseline, { "format:schema-parse-failure": 40 }, 200);
    expect(spikes).toHaveLength(1);
    expect(spikes[0].rule).toBe("format:schema-parse-failure");
    expect(spikes[0].current_rate).toBeGreaterThan(spikes[0].baseline_rate);
  });

  it("stays QUIET on normal variance (rate near or below baseline)", () => {
    expect(detectSpikes(baseline, { "format:schema-parse-failure": 6 }, 800)).toHaveLength(0);
  });

  it("flags a brand-NEW rule that never fired in the baseline", () => {
    const spikes = detectSpikes(baseline, { "format:brand-new-break": 10 }, 200);
    expect(spikes).toHaveLength(1);
    expect(spikes[0].new_rule).toBe(true);
  });

  it("ignores tiny-count noise below MIN_FIRED", () => {
    expect(detectSpikes(baseline, { "format:schema-parse-failure": 3 }, 10, { minFired: 5 })).toHaveLength(0);
  });
});
