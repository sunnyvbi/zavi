
import { describe, it, expect } from "vitest";

type AnchorRow = {
  id: string;
  slug: string;
  title: string;
  body_markdown: string;
  updated_at: string;
  metadata: { tier?: string; source?: string; candidate_id?: string } | null;
};

function splitByTier(anchors: AnchorRow[]) {
  return {
    primary: anchors.filter((a) => a.metadata?.tier === "primary"),
    canonical: anchors.filter((a) => a.metadata?.tier !== "primary"),
  };
}

const mkRow = (over: Partial<AnchorRow>): AnchorRow => ({
  id: "row-x",
  slug: "x",
  title: "x.md",
  body_markdown: "",
  updated_at: "2026-05-17T00:00:00Z",
  metadata: null,
  ...over,
});

describe("splitByTier (T23 — BrainTab anchor split)", () => {
  it("renders primary FIRST + canonical separately", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "c-1", slug: "company", metadata: { tier: "canonical" } }),
      mkRow({
        id: "p-1",
        slug: "cohort-delivery",
        metadata: { tier: "primary", candidate_id: "id-1" },
      }),
      mkRow({ id: "c-2", slug: "ops", metadata: { tier: "canonical" } }),
      mkRow({
        id: "p-2",
        slug: "curriculum",
        metadata: { tier: "primary", candidate_id: "id-2" },
      }),
    ];
    const { primary, canonical } = splitByTier(anchors);
    expect(primary.map((r) => r.slug)).toEqual(["cohort-delivery", "curriculum"]);
    expect(canonical.map((r) => r.slug)).toEqual(["company", "ops"]);
  });

  it("treats null/missing metadata as canonical (back-compat for pre-tier rows)", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "old-1", slug: "company", metadata: null }),
      mkRow({ id: "old-2", slug: "ops", metadata: {} }),
      mkRow({
        id: "p-1",
        slug: "cohort-delivery",
        metadata: { tier: "primary" },
      }),
    ];
    const { primary, canonical } = splitByTier(anchors);
    expect(primary).toHaveLength(1);
    expect(canonical.map((r) => r.slug)).toEqual(["company", "ops"]);
  });

  it("empty-primary case (skip path) → primary=[], no empty-state copy", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "c-1", slug: "company", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-2", slug: "ops", metadata: { tier: "canonical" } }),
    ];
    const { primary, canonical } = splitByTier(anchors);
    expect(primary).toEqual([]);
    expect(primary.length > 0).toBe(false);
    expect(canonical).toHaveLength(2);
  });

  it("primary order = ascending updated_at (matches activate insertion order)", () => {
    const anchors: AnchorRow[] = [
      mkRow({
        id: "p-third",
        slug: "third",
        updated_at: "2026-05-17T00:00:30Z",
        metadata: { tier: "primary" },
      }),
      mkRow({
        id: "p-first",
        slug: "first",
        updated_at: "2026-05-17T00:00:10Z",
        metadata: { tier: "primary" },
      }),
      mkRow({
        id: "p-second",
        slug: "second",
        updated_at: "2026-05-17T00:00:20Z",
        metadata: { tier: "primary" },
      }),
    ];
    const { primary } = splitByTier(anchors);
    const ordered = [...primary].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    expect(ordered.map((r) => r.slug)).toEqual(["first", "second", "third"]);
  });
});

describe.skip("BrainTab render (TODO — needs @testing-library/react)", () => {
  it("renders 'Your fleet's priorities' section when ≥1 primary", () => {});
  it("hides 'Your fleet's priorities' section when 0 primary (no empty-state copy)", () => {});
  it("'System core' collapses by default after first visit (localStorage)", () => {});
  it("'System core' click toggles open/closed + persists state", () => {});
});
