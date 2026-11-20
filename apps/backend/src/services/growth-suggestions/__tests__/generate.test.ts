import { describe, expect, it } from "vitest";
import {
  attachDuplicateWarnings,
  describeGeneration,
  evidenceSources,
  parseGeneratedSuggestions,
  previousThirtyDayRange,
  suggestionSimilarity,
  toPreview,
  type GrowthSuggestionPreview,
} from "../generate";
import type { EvidenceRef } from "@/services/client-context";

function preview(overrides: Partial<GrowthSuggestionPreview> = {}): GrowthSuggestionPreview {
  return {
    preview_id: "preview-1",
    title: "Protect branded search terms",
    body: "Add exact-match brand terms to the always-on search campaign.",
    category: "campaign",
    priority: "medium",
    source: "ai_evidence",
    source_payload: {
      campaign_ids: [],
      sources: [],
      evidence_refs: [],
      metrics_snapshot: [],
      time_range: { since: "2026-07-08", until: "2026-08-07" },
      prior_time_range: { since: "2026-06-08", until: "2026-07-07" },
      pixel_health: { overall_status: "healthy", pixels_found: 1 },
    },
    ...overrides,
  };
}

describe("parseGeneratedSuggestions", () => {
  it("accepts fenced strict JSON and preserves the structured fields", () => {
    const raw = `\`\`\`json
      {"suggestions":[
        {"title":"A","body":"Evidence A","category":"creative","priority":"high","campaign_ids":["1"],"evidence_refs":["CTR fell"]},
        {"title":"B","body":"Evidence B","category":"campaign","priority":"medium","campaign_ids":[],"evidence_refs":["Spend rose"]},
        {"title":"C","body":"Evidence C","category":"landing_page","priority":"low","campaign_ids":[],"evidence_refs":["Clicks did not convert"]}
      ]}
    \`\`\``;
    const result = parseGeneratedSuggestions(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ category: "creative", priority: "high", campaign_ids: ["1"] });
  });

  it("rejects previews outside the required 3..8 range", () => {
    expect(() => parseGeneratedSuggestions('{"suggestions":[]}')).toThrow();
  });

  it("rejects ungrounded recommendations with no evidence reference", () => {
    const raw = JSON.stringify({ suggestions: [
      { title: "A", body: "A", category: "creative", priority: "high", campaign_ids: [], evidence_refs: [] },
      { title: "B", body: "B", category: "campaign", priority: "medium", campaign_ids: [], evidence_refs: ["Spend rose"] },
      { title: "C", body: "C", category: "budget", priority: "low", campaign_ids: [], evidence_refs: ["ROAS fell"] },
    ] });
    expect(() => parseGeneratedSuggestions(raw)).toThrow();
  });

  it("coerces bare-string evidence_refs and campaign_ids into arrays", () => {
    const raw = JSON.stringify({
      suggestions: [
        {
          title: "A",
          body: "Evidence A",
          category: "creative",
          priority: "high",
          campaign_ids: "camp-1",
          evidence_refs: "CTR fell from 2.1% to 1.4% WoW on Prospecting",
        },
        {
          title: "B",
          body: "Evidence B",
          category: "campaign",
          priority: "medium",
          campaign_ids: [],
          evidence_refs: "Spend rose while ROAS fell",
        },
        {
          title: "C",
          body: "Evidence C",
          category: "landing_page",
          priority: "low",
          campaign_ids: [],
          evidence_refs: ["Clicks did not convert"],
        },
      ],
    });
    const result = parseGeneratedSuggestions(raw);
    expect(result[0]).toMatchObject({
      campaign_ids: ["camp-1"],
      evidence_refs: ["CTR fell from 2.1% to 1.4% WoW on Prospecting"],
    });
    expect(result[1]?.evidence_refs).toEqual(["Spend rose while ROAS fell"]);
    expect(result[2]?.evidence_refs).toEqual(["Clicks did not convert"]);
  });
});

describe("duplicate matching", () => {
  it("finds title/body variants but ignores an unrelated suggestion", () => {
    const similar = suggestionSimilarity(
      preview(),
      { title: "Protect brand search traffic", body: "Add exact match branded terms to search." },
    );
    const unrelated = suggestionSimilarity(
      preview(),
      { title: "Refresh summer video creative", body: "Test new product-led images." },
    );
    expect(similar).toBeGreaterThanOrEqual(0.55);
    expect(unrelated).toBeLessThan(0.55);
  });

  it("attaches only the strongest open-ledger match", () => {
    const [result] = attachDuplicateWarnings([preview()], [
      { id: "weak", title: "Protect traffic", body: "Review search.", status: "draft" },
      { id: "strong", title: "Protect branded search terms", body: "Add exact match brand terms.", status: "awaiting_client" },
      { id: "other", title: "New landing page", body: "Test pricing proof.", status: "draft" },
    ]);
    expect(result.duplicate).toMatchObject({ id: "strong", status: "awaiting_client" });
  });
});

describe("previousThirtyDayRange", () => {
  it("returns the 30 full days immediately before the current 30-day window", () => {
    expect(previousThirtyDayRange(new Date("2026-08-07T12:00:00Z"))).toEqual({
      since: "2026-06-08",
      until: "2026-07-07",
    });
  });
});

const CAMPAIGN = {
  campaign_id: "cmp-1",
  campaign_name: "Prospecting",
  spend_usd: 500,
  impressions: 10000,
  clicks: 200,
  ctr_percent: 2,
  frequency: 1.5,
  conversions: 10,
  purchases: 8,
  purchase_value_usd: 1200,
  roas: 2.4,
  cpa_usd: 50,
};
const OTHER_CAMPAIGN = { ...CAMPAIGN, campaign_id: "cmp-2", campaign_name: "Retargeting", spend_usd: 900 };
const READ = {
  campaigns: [CAMPAIGN, OTHER_CAMPAIGN],
  time_range: { since: "2026-07-08", until: "2026-08-07" },
  status_filter: "ALL",
  ad_account_id: "act_1",
};
const CATALOG: EvidenceRef[] = [
  { provenance: "connected" as const, source: "ga4", label: "Organic search performance", value: "1,200 customers, conv. 3.1%", observed_at: "2026-08-07T00:00:00Z" },
  { provenance: "connected" as const, source: "autopilot_goals", label: "Goal: Grow weekly signups", value: "weekly signups 338 → 500", observed_at: "2026-08-01T00:00:00Z" },
  { provenance: "connected" as const, source: "meta_ads", label: "Prospecting performance", value: "spend $500, ROAS 2.40×", observed_at: "2026-08-07T00:00:00Z" },
];
const GENERATED_AT = "2026-08-08T00:00:00Z";

function generated(overrides: Partial<Parameters<typeof toPreview>[0]> = {}) {
  return {
    title: "Double down on organic search",
    body: "Organic search converts above paid; expand the content that already ranks.",
    category: "landing_page" as const,
    priority: "medium" as const,
    campaign_ids: [],
    evidence_refs: ["E1", "E2"],
    ...overrides,
  };
}

describe("toPreview provenance", () => {
  it("labels a GA4 + goals suggestion as ai_evidence with no Meta metrics attached", () => {
    const result = toPreview(generated(), 0, {
      current: READ,
      prior: READ,
      pixel: { overall_status: "healthy", pixels_found: 1 },
      evidence: CATALOG,
      generated_at: GENERATED_AT,
    });
    expect(result.source).toBe("ai_evidence");
    expect(result.source_payload.sources).toEqual(["ga4", "autopilot_goals"]);
    expect(result.source_payload.campaign_ids).toEqual([]);
    expect(result.source_payload.metrics_snapshot).toEqual([]);
    expect(result.source_payload.evidence?.map((ref) => ref.source)).toEqual(["ga4", "autopilot_goals"]);
  });

  it("keeps only the cited Meta campaign and records meta_ads alongside other providers", () => {
    const result = toPreview(
      generated({ campaign_ids: ["cmp-1", "unknown"], evidence_refs: ["E3", "E1"] }),
      1,
      { current: READ, prior: READ, pixel: {}, evidence: CATALOG, generated_at: GENERATED_AT },
    );
    expect(result.preview_id).toBe("preview-2");
    expect(result.source_payload.campaign_ids).toEqual(["cmp-1"]);
    expect(result.source_payload.metrics_snapshot.map((row) => row.campaign_id)).toEqual(["cmp-1"]);
    expect(result.source_payload.sources).toEqual(["meta_ads", "ga4"]);
  });

  it("does not count unsourced model notes as a provider", () => {
    expect(evidenceSources([{ source: "model_assertion" }, { source: "ga4" }], [])).toEqual(["ga4"]);
    expect(evidenceSources([], ["cmp-1"])).toEqual(["meta_ads"]);
  });
});

describe("describeGeneration", () => {
  it("does not claim the suggestions came from ads", () => {
    const text = describeGeneration(3, 1);
    expect(text).toContain("available evidence");
    expect(text).toContain("1 possible duplicate");
    expect(text).not.toMatch(/live ads/i);
  });
});
