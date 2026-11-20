import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { CHANNELS, CONNECTOR_FREE_TOOLS } from "@zavi/shared";

const RECIPES = join(__dirname, "../../../channels");

const SCHEDULED = new Set(["daily", "weekly", "biweekly", "monthly"]);

function recipeCadence(slug: string): string | null {
  const p = join(RECIPES, slug, "recipe.md");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^cadence:\s*(\S+)/m);
  return m ? m[1] : null;
}

function isSchedulable(ch: { connectors: readonly string[]; tools: readonly string[] }): boolean {
  if (ch.connectors.length > 0) return true;
  const free = CONNECTOR_FREE_TOOLS as readonly string[];
  return ch.tools.some((t) => free.includes(t));
}

describe("BUG 18 — every scheduled cadence is reachable by the sweep", () => {
  it("no channel promises a cadence due.ts will always skip", () => {
    const broken: string[] = [];
    for (const ch of CHANNELS) {
      const cadence = recipeCadence(ch.slug);
      if (!cadence || !SCHEDULED.has(cadence)) continue;
      if (!isSchedulable(ch)) {
        broken.push(
          `${ch.slug}: cadence "${cadence}" but connectors=[] and no CONNECTOR_FREE tool ` +
            `(tools: ${ch.tools.length ? ch.tools.join(", ") : "none"}) — due.ts:116 skips it for every tenant`,
        );
      }
    }
    expect(
      broken,
      `These channels declare a cadence the sweep can never honour. Either give the ` +
        `channel a connector-free read (what #2386 did for reddit_organic) or declare ` +
        `cadence: on_demand, which is the honest state:\n  - ${broken.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("a channel WITH a connector-free tool stays schedulable (reddit_organic, the #2386 fix)", () => {
    const reddit = CHANNELS.find((c) => c.slug === "reddit_organic");
    expect(reddit).toBeDefined();
    expect(isSchedulable(reddit!)).toBe(true);
    expect(recipeCadence("reddit_organic")).toBe("weekly");
  });

  it("a channel WITH declared connectors stays schedulable (meta_ads)", () => {
    const meta = CHANNELS.find((c) => c.slug === "meta_ads");
    expect(meta).toBeDefined();
    expect(meta!.connectors.length).toBeGreaterThan(0);
    expect(isSchedulable(meta!)).toBe(true);
  });

  it("the detector would CATCH a regression, not just pass today", () => {
    const synthetic = { connectors: [] as string[], tools: ["some_connectorful_tool"] };
    expect(isSchedulable(synthetic)).toBe(false);
  });
});
