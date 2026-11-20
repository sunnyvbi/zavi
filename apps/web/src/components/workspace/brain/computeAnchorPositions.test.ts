
import { describe, it, expect } from "vitest";

type AnchorLike = { slug: string; tier: "canonical" | "primary" };

function computeAnchorPositions(
  anchors: ReadonlyArray<AnchorLike>,
  dims: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const baseRCanonical = Math.min(dims.width, dims.height) * 0.30;
  const baseRPrimary = Math.min(dims.width, dims.height) * 0.18;
  const cx = 0;
  const cy = 0;
  const out = new Map<string, { x: number; y: number }>();

  const canonical = anchors.filter((a) => a.tier !== "primary");
  const primary = anchors.filter((a) => a.tier === "primary");

  canonical.forEach((a, i) => {
    const angle =
      (i / Math.max(canonical.length, 1)) * Math.PI * 2 - Math.PI / 2;
    out.set(a.slug, {
      x: cx + Math.cos(angle) * baseRCanonical,
      y: cy + Math.sin(angle) * baseRCanonical,
    });
  });

  const primaryAngleOffset =
    primary.length > 1 ? Math.PI / primary.length : 0;
  primary.forEach((a, i) => {
    const angle =
      primary.length === 1
        ? -Math.PI / 2
        : (i / primary.length) * Math.PI * 2 - Math.PI / 2 + primaryAngleOffset;
    out.set(a.slug, {
      x: cx + Math.cos(angle) * baseRPrimary,
      y: cy + Math.sin(angle) * baseRPrimary,
    });
  });

  return out;
}

const DIMS = { width: 800, height: 620 };
const R_CANON = Math.min(DIMS.width, DIMS.height) * 0.30;
const R_PRIM = Math.min(DIMS.width, DIMS.height) * 0.18;

const FIVE_CANONICAL: AnchorLike[] = [
  { slug: "company", tier: "canonical" },
  { slug: "ops", tier: "canonical" },
  { slug: "policies", tier: "canonical" },
  { slug: "disputes", tier: "canonical" },
  { slug: "support", tier: "canonical" },
];

function approx(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}

function distanceFromOrigin(p: { x: number; y: number }) {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

describe("computeAnchorPositions (T11 — two-radius layout)", () => {
  it("zero-primary tenant → 5 outer-pentagon positions only", () => {
    const out = computeAnchorPositions(FIVE_CANONICAL, DIMS);
    expect(out.size).toBe(5);
    for (const slug of ["company", "ops", "policies", "disputes", "support"]) {
      const p = out.get(slug);
      expect(p).toBeDefined();
      expect(approx(distanceFromOrigin(p!), R_CANON, 1e-9)).toBe(true);
    }
  });

  it("5 canonical + 3 primary → 8 positions, primary on inner ring", () => {
    const anchors: AnchorLike[] = [
      ...FIVE_CANONICAL,
      { slug: "cohort-delivery", tier: "primary" },
      { slug: "curriculum", tier: "primary" },
      { slug: "retention", tier: "primary" },
    ];
    const out = computeAnchorPositions(anchors, DIMS);
    expect(out.size).toBe(8);

    for (const slug of ["company", "ops", "policies", "disputes", "support"]) {
      const p = out.get(slug)!;
      expect(approx(distanceFromOrigin(p), R_CANON, 1e-9)).toBe(true);
    }
    for (const slug of ["cohort-delivery", "curriculum", "retention"]) {
      const p = out.get(slug)!;
      expect(approx(distanceFromOrigin(p), R_PRIM, 1e-9)).toBe(true);
    }
  });

  it("single primary lands at top-center (angle = -π/2)", () => {
    const anchors: AnchorLike[] = [
      ...FIVE_CANONICAL,
      { slug: "only-pick", tier: "primary" },
    ];
    const out = computeAnchorPositions(anchors, DIMS);
    const p = out.get("only-pick")!;
    expect(approx(p.x, 0, 1e-9)).toBe(true);
    expect(approx(p.y, -R_PRIM, 1e-9)).toBe(true);
  });

  it("two primary nodes sit on opposite halves of the inner ring", () => {
    const anchors: AnchorLike[] = [
      ...FIVE_CANONICAL,
      { slug: "p-a", tier: "primary" },
      { slug: "p-b", tier: "primary" },
    ];
    const out = computeAnchorPositions(anchors, DIMS);
    const a = out.get("p-a")!;
    const b = out.get("p-b")!;
    expect(approx(distanceFromOrigin(a), R_PRIM, 1e-9)).toBe(true);
    expect(approx(distanceFromOrigin(b), R_PRIM, 1e-9)).toBe(true);
    expect(approx(a.x + b.x, 0, 1e-9)).toBe(true);
    expect(approx(a.y + b.y, 0, 1e-9)).toBe(true);
  });

  it("inner-ring half-step offset → no primary sits directly behind a canonical", () => {
    const anchors: AnchorLike[] = [
      ...FIVE_CANONICAL,
      { slug: "p-1", tier: "primary" },
      { slug: "p-2", tier: "primary" },
      { slug: "p-3", tier: "primary" },
    ];
    const out = computeAnchorPositions(anchors, DIMS);
    const canonicalAngles = ["company", "ops", "policies", "disputes", "support"]
      .map((s) => out.get(s)!)
      .map((p) => Math.atan2(p.y, p.x));
    const primaryAngles = ["p-1", "p-2", "p-3"]
      .map((s) => out.get(s)!)
      .map((p) => Math.atan2(p.y, p.x));
    for (const pa of primaryAngles) {
      for (const ca of canonicalAngles) {
        const diff = Math.min(
          Math.abs(pa - ca),
          2 * Math.PI - Math.abs(pa - ca),
        );
        expect(diff).toBeGreaterThan((10 * Math.PI) / 180);
      }
    }
  });

  it("scales with the canvas dims (radius proportional to min-dim)", () => {
    const tiny = computeAnchorPositions(
      [
        ...FIVE_CANONICAL,
        { slug: "p", tier: "primary" },
      ],
      { width: 400, height: 400 },
    );
    const big = computeAnchorPositions(
      [
        ...FIVE_CANONICAL,
        { slug: "p", tier: "primary" },
      ],
      { width: 1600, height: 1600 },
    );
    const tinyR = distanceFromOrigin(tiny.get("company")!);
    const bigR = distanceFromOrigin(big.get("company")!);
    expect(approx(bigR / tinyR, 4, 1e-9)).toBe(true);
  });
});
