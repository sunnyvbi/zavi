
import { describe, it, expect } from "vitest";

type AnchorRow = {
  id: string;
  slug: string;
  title: string;
  body_markdown: string;
  updated_at: string;
  metadata: { tier?: string; source?: string; candidate_id?: string } | null;
};

type CanonicalSlug = { slug: string; label: string; hint: string };

type AnchorInput = {
  id: string;
  slug: string;
  label: string;
  body: string;
  written: boolean;
  tier: "canonical" | "primary";
  primary_rank?: number;
};

function buildAnchorInputs(
  anchors: AnchorRow[],
  canonicalSlugs: ReadonlyArray<CanonicalSlug>,
): AnchorInput[] {
  const primaryAnchors = anchors.filter(
    (a) => a.metadata?.tier === "primary",
  );
  const canonicalAnchors = anchors.filter(
    (a) => a.metadata?.tier !== "primary",
  );
  const orderedPrimary = [...primaryAnchors].sort((a, b) =>
    a.updated_at.localeCompare(b.updated_at),
  );

  const bySlug = new Map(anchors.map((a) => [a.slug, a]));
  const canonicalBySlug = new Map(canonicalAnchors.map((a) => [a.slug, a]));
  const canonical: AnchorInput[] = canonicalSlugs.map((s) => {
    const row = canonicalBySlug.get(s.slug) ?? bySlug.get(s.slug);
    return {
      id: row?.id ?? `placeholder:${s.slug}`,
      slug: s.slug,
      label: s.label,
      body: row?.body_markdown ?? s.hint,
      written: Boolean(row),
      tier: "canonical" as const,
    };
  });
  const primary: AnchorInput[] = orderedPrimary.map((p, idx) => ({
    id: p.id,
    slug: p.slug,
    label: p.title,
    body: p.body_markdown,
    written: true,
    tier: "primary" as const,
    primary_rank: idx + 1,
  }));
  return [...canonical, ...primary];
}

const ANCHOR_SLUGS: ReadonlyArray<CanonicalSlug> = [
  { slug: "company", label: "Company brief", hint: "" },
  { slug: "ops", label: "Operating priorities", hint: "" },
  { slug: "policies", label: "Policies", hint: "" },
  { slug: "disputes", label: "Disputes anchor", hint: "" },
  { slug: "support", label: "Support anchor", hint: "" },
];

const mkRow = (over: Partial<AnchorRow>): AnchorRow => ({
  id: "row-x",
  slug: "x",
  title: "x.md",
  body_markdown: "",
  updated_at: "2026-05-18T00:00:00Z",
  metadata: null,
  ...over,
});

describe("buildAnchorInputs (T10 — BrainTab graph inputs with tier tagging)", () => {
  it("returns 5 canonical + N primary when both tiers present", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "c-1", slug: "company", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-2", slug: "ops", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-3", slug: "policies", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-4", slug: "disputes", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-5", slug: "support", metadata: { tier: "canonical" } }),
      mkRow({
        id: "p-1",
        slug: "cohort-delivery",
        title: "cohort-delivery.md",
        body_markdown: "body 1",
        updated_at: "2026-05-18T00:00:10Z",
        metadata: { tier: "primary", candidate_id: "id-1" },
      }),
      mkRow({
        id: "p-2",
        slug: "curriculum",
        title: "curriculum.md",
        body_markdown: "body 2",
        updated_at: "2026-05-18T00:00:20Z",
        metadata: { tier: "primary", candidate_id: "id-2" },
      }),
      mkRow({
        id: "p-3",
        slug: "retention",
        title: "retention.md",
        body_markdown: "body 3",
        updated_at: "2026-05-18T00:00:30Z",
        metadata: { tier: "primary", candidate_id: "id-3" },
      }),
    ];
    const out = buildAnchorInputs(anchors, ANCHOR_SLUGS);
    expect(out).toHaveLength(8);

    const canonical = out.filter((a) => a.tier === "canonical");
    const primary = out.filter((a) => a.tier === "primary");
    expect(canonical).toHaveLength(5);
    expect(primary).toHaveLength(3);

    expect(canonical.map((a) => a.slug)).toEqual([
      "company",
      "ops",
      "policies",
      "disputes",
      "support",
    ]);
    for (const c of canonical) {
      expect(c.written).toBe(true);
      expect(c.primary_rank).toBeUndefined();
    }

    expect(primary.map((a) => a.slug)).toEqual([
      "cohort-delivery",
      "curriculum",
      "retention",
    ]);
    expect(primary.map((a) => a.primary_rank)).toEqual([1, 2, 3]);
    for (const p of primary) {
      expect(p.written).toBe(true);
    }
  });

  it("zero-primary tenant returns 5 canonical only, all tier=canonical", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "c-1", slug: "company", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-2", slug: "ops", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-3", slug: "policies", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-4", slug: "disputes", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-5", slug: "support", metadata: { tier: "canonical" } }),
    ];
    const out = buildAnchorInputs(anchors, ANCHOR_SLUGS);
    expect(out).toHaveLength(5);
    expect(out.every((a) => a.tier === "canonical")).toBe(true);
    expect(out.every((a) => a.primary_rank === undefined)).toBe(true);
  });

  it("back-compat: rows with null metadata count as canonical (pre-tier rows)", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "old-1", slug: "company", metadata: null }),
      mkRow({ id: "old-2", slug: "ops", metadata: {} }),
      mkRow({ id: "old-3", slug: "policies", metadata: null }),
      mkRow({ id: "old-4", slug: "disputes", metadata: null }),
      mkRow({ id: "old-5", slug: "support", metadata: null }),
    ];
    const out = buildAnchorInputs(anchors, ANCHOR_SLUGS);
    expect(out).toHaveLength(5);
    expect(out.every((a) => a.tier === "canonical")).toBe(true);
    expect(out.every((a) => a.written)).toBe(true);
  });

  it("single-primary tenant returns 5 canonical + 1 primary with rank=1", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "c-1", slug: "company", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-2", slug: "ops", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-3", slug: "policies", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-4", slug: "disputes", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-5", slug: "support", metadata: { tier: "canonical" } }),
      mkRow({
        id: "p-1",
        slug: "the-only-one",
        title: "only.md",
        body_markdown: "body",
        metadata: { tier: "primary" },
      }),
    ];
    const out = buildAnchorInputs(anchors, ANCHOR_SLUGS);
    expect(out).toHaveLength(6);
    const primary = out.filter((a) => a.tier === "primary");
    expect(primary).toHaveLength(1);
    expect(primary[0].primary_rank).toBe(1);
    expect(primary[0].slug).toBe("the-only-one");
  });

  it("missing canonical row leaves a placeholder with written=false", () => {
    const anchors: AnchorRow[] = [
      mkRow({ id: "c-1", slug: "company", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-3", slug: "policies", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-4", slug: "disputes", metadata: { tier: "canonical" } }),
      mkRow({ id: "c-5", slug: "support", metadata: { tier: "canonical" } }),
    ];
    const out = buildAnchorInputs(anchors, ANCHOR_SLUGS);
    const ops = out.find((a) => a.slug === "ops");
    expect(ops).toBeDefined();
    expect(ops!.written).toBe(false);
    expect(ops!.id).toBe("placeholder:ops");
    expect(ops!.tier).toBe("canonical");
  });
});
