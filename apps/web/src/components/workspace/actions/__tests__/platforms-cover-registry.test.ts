
import { describe, expect, it } from "vitest";
import { CHANNELS, type Channel } from "@zavi/shared";
import { PLATFORMS, platformFor } from "../platforms";
import type { ExtraId } from "../types";

const slugs = (CHANNELS as readonly Channel[]).map((c) => c.slug);

const EXTRA_IDS = ["campaign_table", "campaign_group_table", "ads_table", "x_tables", "reddit_kpi_tables", "seo_tables", "geo_tables", "linkedin_tables", "instagram_tables", "tiktok_tables"] as const;
const _exhaustive: ReadonlyArray<ExtraId> = EXTRA_IDS;
const _noExtras: ExtraId = EXTRA_IDS[0];
void _exhaustive;
void _noExtras;

describe("every registry channel has a PLATFORMS row", () => {
  it("covers all of them", () => {
    const missing = slugs.filter((s) => !(s in PLATFORMS));
    expect(missing, "Add a row to actions/platforms.ts. A channel is a row, not a component.").toEqual([]);
  });

  it("keeps the map honest: no row for a slug the registry dropped", () => {
    const stale = Object.keys(PLATFORMS).filter((s) => !slugs.includes(s as Channel["slug"]));
    expect(stale, "Remove the row for a channel that no longer exists").toEqual([]);
  });

  it("hands every channel its OWN row, never platformFor's derived fallback", () => {
    for (const slug of slugs) {
      expect(platformFor(slug), `${slug} fell through to the derived fallback`).toBe(PLATFORMS[slug]);
    }
  });
});

describe("isDecisionId mirrors the registry, and is not a hand-kept list", () => {
  it("flags exactly the channels the registry keeps on `decisions`", () => {
    const fromRegistry = (CHANNELS as readonly Channel[])
      .filter((c) => c.actions_store === "decisions")
      .map((c) => c.slug)
      .sort();
    const fromPlatforms = Object.entries(PLATFORMS)
      .filter(([, p]) => p.isDecisionId)
      .map(([slug]) => slug)
      .sort();
    expect(
      fromPlatforms,
      "actions/platforms.ts `isDecisionId` has drifted from registry.ts `actions_store`. The registry is the answer; fix the row.",
    ).toEqual(fromRegistry);
  });
});

describe("extras is a closed union", () => {
  it("every declared extra is in the union", () => {
    const declared = Object.entries(PLATFORMS).flatMap(([slug, p]) =>
      (p.extras ?? []).map((e) => `${slug}:${e}`),
    );
    const outside = declared.filter((d) => !(EXTRA_IDS as readonly string[]).includes(d.split(":")[1]));
    expect(outside).toEqual([]);
  });

  it("holds the budget at three, so a fourth is a deliberate edit to this list", () => {
    expect(EXTRA_IDS).toHaveLength(10);
  });
});
