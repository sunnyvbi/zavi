import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { existingNegativesTool } from "../existing_negatives";

const ctx = { tenant_id: "t-1" } as never;

const fromResource = (query: string) =>
  query.slice(query.indexOf("FROM") + 4).trim().split(/\s+/)[0];

function queryFor(resource: string): string | undefined {
  for (const call of gadsSearch.mock.calls) {
    const q = (call as [string, string])[1];
    if (fromResource(q) === resource) return q;
  }
  return undefined;
}

const campaignNeg = (text: string, match = "BROAD") => ({
  campaign: { id: "1", name: "Search - Core", status: "ENABLED" },
  campaignCriterion: { status: "ENABLED", keyword: { text, matchType: match } },
});
const adGroupNeg = (text: string) => ({
  campaign: { name: "Search - Core" },
  adGroup: { id: "7", name: "Widgets", status: "ENABLED" },
  adGroupCriterion: { status: "ENABLED", keyword: { text, matchType: "PHRASE" } },
});
const sharedNeg = (text: string, referenceCount = "2", name = "Global negatives") => ({
  sharedSet: { id: "5", name, status: "ENABLED", referenceCount },
  sharedCriterion: { keyword: { text, matchType: "BROAD" } },
});

function mockLevels(map: {
  campaign?: unknown[] | Error;
  adGroup?: unknown[] | Error;
  shared?: unknown[] | Error;
}) {
  gadsSearch.mockImplementation(async (_t: string, query: string) => {
    const res = fromResource(query);
    const pick =
      res === "campaign_criterion"
        ? map.campaign
        : res === "ad_group_criterion"
          ? map.adGroup
          : res === "shared_criterion"
            ? map.shared
            : [];
    if (pick instanceof Error) throw pick;
    return pick ?? [];
  });
}

beforeEach(() => {
  gadsSearch.mockReset().mockResolvedValue([]);
});

describe("google_ads_existing_negatives — reads all three levels", () => {
  it("labels each negative with its scope and level", async () => {
    mockLevels({
      campaign: [campaignNeg("free")],
      adGroup: [adGroupNeg("used")],
      shared: [sharedNeg("jobs")],
    });

    const out = (await existingNegativesTool.execute(ctx, {})) as {
      total: number;
      complete: boolean;
      levels_read: string[];
      by_level: Record<string, number>;
      negatives: Array<{ keyword: string; level: string; scope: string }>;
    };

    expect(out.total).toBe(3);
    expect(out.complete).toBe(true);
    expect(out.levels_read.sort()).toEqual(["ad_group", "campaign", "shared_list"]);
    expect(out.by_level).toEqual({ campaign: 1, ad_group: 1, shared_list: 1 });
    expect(out.negatives.find((n) => n.keyword === "used")?.scope).toBe("Search - Core / Widgets");
  });
});

describe("google_ads_existing_negatives — only ACTUALLY blocking terms reach the dedupe index", () => {
  it("excludes a shared list attached to no campaign, and reports it as a finding", async () => {
    mockLevels({
      shared: [
        sharedNeg("blocked-for-real", "3", "Applied list"),
        sharedNeg("not-actually-blocked", "0", "Orphan list"),
      ],
    });

    const out = (await existingNegativesTool.execute(ctx, {})) as {
      blocked_index: string[];
      unattached_lists: string[];
      unattached_lists_note: string | null;
      total: number;
      blocking_total: number;
    };

    expect(out.blocked_index).toContain("blocked-for-real");
    expect(out.blocked_index).not.toContain("not-actually-blocked");
    expect(out.unattached_lists).toEqual(["Orphan list"]);
    expect(out.unattached_lists_note).toContain("attached to NO campaign");
    expect(out.total).toBe(2);
    expect(out.blocking_total).toBe(1);
  });

  it("filters REMOVED criteria at the query, on every level", async () => {
    await existingNegativesTool.execute(ctx, {});

    const campaign = queryFor("campaign_criterion")!;
    expect(campaign).toContain("campaign_criterion.status != 'REMOVED'");
    expect(campaign).toContain("campaign.status != 'REMOVED'");

    const adGroup = queryFor("ad_group_criterion")!;
    expect(adGroup).toContain("ad_group_criterion.status != 'REMOVED'");
    expect(adGroup).toContain("ad_group.status != 'REMOVED'");

    const shared = queryFor("shared_criterion")!;
    expect(shared).toContain("shared_set.status != 'REMOVED'");
  });

  it("keeps singular and plural as distinct blocks — Google negatives do not match close variants", async () => {
    mockLevels({ campaign: [campaignNeg("job")] });
    const out = (await existingNegativesTool.execute(ctx, {})) as { blocked_index: string[] };
    expect(out.blocked_index).toContain("job");
    expect(out.blocked_index).not.toContain("jobs");
  });

  it("normalises only case and whitespace when building the dedupe index", async () => {
    mockLevels({ campaign: [campaignNeg("  Free   Trial "), campaignNeg("free trial")] });
    const out = (await existingNegativesTool.execute(ctx, {})) as {
      blocked_index: string[];
      total: number;
    };
    expect(out.total).toBe(2);
    expect(out.blocked_index.filter((k) => k === "free trial")).toHaveLength(1);
  });
});

describe("google_ads_existing_negatives — a failed level is not an empty level", () => {
  it("marks the read INCOMPLETE and keeps the levels that did work", async () => {
    mockLevels({
      campaign: [campaignNeg("free")],
      adGroup: new Error("google_ads_query_failed: 400"),
      shared: [sharedNeg("jobs")],
    });

    const out = (await existingNegativesTool.execute(ctx, {})) as {
      complete: boolean;
      levels_read: string[];
      levels_failed: Array<{ level: string }>;
      completeness_note: string | null;
      total: number;
    };

    expect(out.complete).toBe(false);
    expect(out.levels_read.sort()).toEqual(["campaign", "shared_list"]);
    expect(out.levels_failed[0].level).toBe("ad_group");
    expect(out.completeness_note).toContain("INCOMPLETE");
    expect(out.total).toBe(2);
  });
});

describe("google_ads_existing_negatives — query hygiene", () => {
  it("never sends a date segment — criteria are settings, not performance", async () => {
    await existingNegativesTool.execute(ctx, {});
    for (const call of gadsSearch.mock.calls) {
      expect((call as [string, string])[1]).not.toContain("segments.date");
    }
  });

  it("filters to NEGATIVE KEYWORD criteria on both criterion levels", async () => {
    await existingNegativesTool.execute(ctx, {});

    const campaign = queryFor("campaign_criterion")!;
    expect(campaign).toContain("campaign_criterion.negative = TRUE");
    expect(campaign).toContain("campaign_criterion.type = 'KEYWORD'");

    const adGroup = queryFor("ad_group_criterion")!;
    expect(adGroup).toContain("ad_group_criterion.negative = TRUE");
    expect(adGroup).toContain("ad_group_criterion.type = 'KEYWORD'");

    const shared = queryFor("shared_criterion")!;
    expect(shared).toContain("shared_set.type = 'NEGATIVE_KEYWORDS'");
  });
});
