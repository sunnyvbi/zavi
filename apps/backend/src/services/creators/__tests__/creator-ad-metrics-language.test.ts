
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREATOR_AD_METRICS_ABSTAIN_BODY,
  CREATOR_AD_METRICS_ABSTAIN_TITLE,
  CREATOR_AD_METRIC_FIELDS,
  CREATOR_AD_METRICS_SCOPE_NOTE,
} from "@zavi/shared";

const REPO = join(__dirname, "../../../../../..");

const SURFACES = [
  "packages/shared/src/creators/ad-metrics.ts",
  "apps/backend/src/services/creators/library-metrics.ts",
  "apps/web/src/components/humans/CreatorLibraryIsland.tsx",
];

const BANNED = [
  /\bvs\b/i,
  /\bversus\b/i,
  /\bcompar(e|ed|es|ing|ison)\b/i,
  /\bbaseline\b/i,
  /\blift\b/i,
  /\boutperform(s|ed|ing)?\b/i,
  /\bbetter than\b/i,
  /\bworse than\b/i,
  /\bbeat\b/i,
  /\bbest[- ]performing\b/i,
  /\btop[- ]performing\b/i,
  /\bbecause\b/i,
  /\bcaused?\b/i,
  /\bdrove\b/i,
  /\broas\b/i,
  /\bcpa\b/i,
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("ad-number copy makes no comparative or causal claim", () => {
  it.each(SURFACES)("%s says nothing comparative", (rel) => {
    const code = stripComments(readFileSync(join(REPO, rel), "utf8"));
    const hits = BANNED.filter((re) => re.test(code)).map((re) => re.source);
    expect(
      hits,
      `${rel} contains comparative/causal/attributed phrasing outside a comment: ${hits.join(", ")}.\n` +
        `These surfaces report ONE ad's own absolute totals. There is no baseline to compare to,\n` +
        `no causal claim the data supports, and no creator to attribute a return to.`,
    ).toEqual([]);
  });

  it("the shipped copy strings themselves are clean", () => {
    for (const copy of [
      CREATOR_AD_METRICS_ABSTAIN_TITLE,
      CREATOR_AD_METRICS_ABSTAIN_BODY,
      CREATOR_AD_METRICS_SCOPE_NOTE,
    ]) {
      for (const re of BANNED) expect(re.test(copy), `"${copy}" matched ${re}`).toBe(false);
    }
  });
});

describe("the stored field list holds no ratio", () => {
  it("is counts and dollar totals only", () => {
    expect([...CREATOR_AD_METRIC_FIELDS]).toEqual([
      "spend_usd",
      "impressions",
      "clicks",
      "reach",
      "conversions",
      "purchases",
      "purchase_value_usd",
    ]);
    for (const ratio of ["roas", "cpa_usd", "ctr_percent", "frequency", "cpc_usd"]) {
      expect(CREATOR_AD_METRIC_FIELDS as readonly string[]).not.toContain(ratio);
    }
  });
});
