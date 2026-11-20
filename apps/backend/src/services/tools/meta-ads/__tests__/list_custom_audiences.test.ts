
import { describe, it, expect } from "vitest";
import { listMetaAdsTools } from "@/services/mcp/internal/meta-ads";
import {
  metaListCustomAudiencesTool,
  normalizeCount,
  daysSince,
  buildUsageIndex,
  mapAudience,
} from "../list_custom_audiences";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("meta_ads__list_custom_audiences registration", () => {
  it("is advertised by the meta_ads facade under tool_name 'list_custom_audiences'", () => {
    const names = listMetaAdsTools().map((t) => t.tool_name);
    expect(names).toContain("list_custom_audiences");
  });

  it("keeps the legacy meta_ads_ prefix on the spec name", () => {
    expect(metaListCustomAudiencesTool.name).toBe("meta_ads_list_custom_audiences");
  });

  it("warns the agent in its description not to invent a size or a usage verdict", () => {
    expect(metaListCustomAudiencesTool.description).toMatch(/never invent a number/i);
    expect(metaListCustomAudiencesTool.description).toMatch(/must NOT describe any audience as unused/i);
  });

  it("is declared in performance-marketer frontmatter, else discovery filters it out", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const md = readFileSync(
      join(__dirname, "..", "..", "..", "..", "agents", "performance-marketer", "agent.md"),
      "utf-8",
    );
    expect(md).toContain("- meta_ads__list_custom_audiences");
  });
});

describe("normalizeCount", () => {
  it("passes through a real count", () => {
    expect(normalizeCount(2_100_000)).toBe(2_100_000);
    expect(normalizeCount(0)).toBe(0);
  });

  it("maps Meta's -1 'not computed' sentinel to null, never a headcount of -1", () => {
    expect(normalizeCount(-1)).toBeNull();
  });

  it("rejects any negative, non-finite, or absent bound", () => {
    expect(normalizeCount(-500)).toBeNull();
    expect(normalizeCount(Number.NaN)).toBeNull();
    expect(normalizeCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeCount(undefined)).toBeNull();
  });
});

describe("daysSince", () => {
  it("counts whole days back from the reference instant", () => {
    expect(daysSince("2026-08-16T12:00:00.000Z", NOW)).toBe(10);
  });

  it("returns null — not 0 — when Meta sent nothing, so it never reads as 'refreshed today'", () => {
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince("not-a-date", NOW)).toBeNull();
  });

  it("clamps a future timestamp to 0 rather than reporting negative age", () => {
    expect(daysSince("2026-09-01T00:00:00.000Z", NOW)).toBe(0);
  });
});

describe("buildUsageIndex", () => {
  const adsets = [
    {
      id: "as_1",
      name: "SF Purchase",
      effective_status: "ACTIVE",
      targeting: {
        custom_audiences: [{ id: "aud_lookalike", name: "LAL Purchasers 1%" }],
        excluded_custom_audiences: [{ id: "aud_suppress", name: "Existing customers" }],
      },
    },
    {
      id: "as_2",
      name: "LA Purchase",
      effective_status: "PAUSED",
      targeting: { custom_audiences: [{ id: "aud_lookalike", name: "LAL Purchasers 1%" }] },
    },
  ];

  it("indexes every ad set that includes an audience", () => {
    const idx = buildUsageIndex(adsets);
    expect(idx.get("aud_lookalike")).toEqual([
      { adset_id: "as_1", adset_name: "SF Purchase", effective_status: "ACTIVE", mode: "included" },
      { adset_id: "as_2", adset_name: "LA Purchase", effective_status: "PAUSED", mode: "included" },
    ]);
  });

  it("records an exclusion distinctly, so a suppression list never looks unused", () => {
    const idx = buildUsageIndex(adsets);
    expect(idx.get("aud_suppress")).toEqual([
      { adset_id: "as_1", adset_name: "SF Purchase", effective_status: "ACTIVE", mode: "excluded" },
    ]);
  });

  it("ignores ad sets with no targeting block rather than throwing", () => {
    expect(buildUsageIndex([{ id: "as_3", name: "No targeting" }]).size).toBe(0);
  });
});

describe("mapAudience", () => {
  const row = {
    id: "aud_lookalike",
    name: "LAL Purchasers 1%",
    subtype: "LOOKALIKE",
    approximate_count_lower_bound: 2_000_000,
    approximate_count_upper_bound: 2_100_000,
    delivery_status: { code: 200, description: "This audience is ready to be used." },
    operation_status: { code: 200, description: "Normal" },
    time_updated: "2026-08-16T12:00:00.000Z",
    retention_days: 180,
  };

  it("passes Meta's own delivery verdict through verbatim", () => {
    const m = mapAudience(row, [], NOW);
    expect(m.delivery_status).toBe("This audience is ready to be used.");
    expect(m.delivery_status_code).toBe(200);
  });

  it("reports in_use=false for an audience nothing targets", () => {
    const m = mapAudience(row, [], NOW);
    expect(m.in_use).toBe(false);
  });

  it("reports in_use=true when at least one ad set INCLUDES it", () => {
    const m = mapAudience(row, [
      { adset_id: "as_1", adset_name: "SF", effective_status: "ACTIVE", mode: "included" as const },
    ], NOW);
    expect(m.in_use).toBe(true);
  });

  it("does NOT count an exclusion-only reference as in use", () => {
    const m = mapAudience(row, [
      { adset_id: "as_1", adset_name: "SF", effective_status: "ACTIVE", mode: "excluded" as const },
    ], NOW);
    expect(m.in_use).toBe(false);
    expect(m.used_by_ad_sets).toHaveLength(1);
  });

  it("LOAD-BEARING: usage=null means UNKNOWN, not unused", () => {
    const m = mapAudience(row, null, NOW);
    expect(m.in_use).toBeNull();
    expect(m.in_use).not.toBe(false);
    expect(m.used_by_ad_sets).toBeNull();
  });

  it("nulls an unavailable size instead of leaking Meta's -1 sentinel", () => {
    const m = mapAudience(
      { ...row, approximate_count_lower_bound: -1, approximate_count_upper_bound: -1 },
      [],
      NOW,
    );
    expect(m.approximate_size_lower_bound).toBeNull();
    expect(m.approximate_size_upper_bound).toBeNull();
    expect(m.size_available).toBe(false);
  });

  it("computes staleness from time_updated", () => {
    expect(mapAudience(row, [], NOW).days_since_updated).toBe(10);
  });

  it("does not invent a name or subtype for a sparse row", () => {
    const m = mapAudience({ id: "aud_x" }, [], NOW);
    expect(m.name).toBe("(unnamed)");
    expect(m.subtype).toBeNull();
    expect(m.delivery_status).toBeNull();
    expect(m.days_since_updated).toBeNull();
  });
});
