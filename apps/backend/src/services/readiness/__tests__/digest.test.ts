import { describe, it, expect } from "vitest";
import { renderReadinessDigest, topBlocker } from "../digest";

const t = (name: string, score: number, prev: number | null, dims: Record<string, number>) => ({
  tenant_id: `id-${name}`,
  name,
  prev_score: prev,
  score,
  dims,
});

const FULL = {
  verified_brain: 20,
  product_url: 10,
  connectors: 30,
  goal_measurable: 15,
  deliverable: 15,
  founder_engaged: 10,
};

describe("topBlocker — names the biggest single gap", () => {
  it("connectors dominate when unwired", () => {
    expect(topBlocker({ ...FULL, connectors: 0 })).toMatch(/^connectors \(-30\)/);
  });
  it("falls through to the next-biggest gap", () => {
    expect(topBlocker({ ...FULL, connectors: 30, verified_brain: 0 })).toMatch(/^verified brain \(-20\)/);
  });
  it("a fully-ready tenant is blocked by nothing", () => {
    expect(topBlocker(FULL)).toBe("nothing");
  });
});

describe("readiness digest", () => {
  it("leads with the drafts to review when discovery found something", () => {
    const { subject, text } = renderReadinessDigest({
      tenants: [t("E Closet", 46, 46, { ...FULL, connectors: 10, product_url: 0 })],
      drafts: [
        {
          tenant_name: "E Closet",
          canonical_slug: "company",
          confidence: "high",
          snippet: "US college fashion-rental marketplace, launched at Auburn.",
        },
      ],
      dispatched: 1,
      parked: 4,
    });
    expect(subject).toMatch(/1 draft to review/);
    expect(text.indexOf("Discovery wrote 1 draft")).toBeLessThan(text.indexOf("Fleet:"));
    expect(text).toContain("[HIGH] E Closet / company");
    expect(text).toContain("Auburn");
  });

  it("says so plainly when there is nothing to review", () => {
    const { subject, text } = renderReadinessDigest({
      tenants: [t("Zavi", 58, 58, FULL)],
      drafts: [],
      dispatched: 0,
      parked: 1,
    });
    expect(subject).toMatch(/no new drafts/);
    expect(text).toContain("Discovery wrote no new drafts");
  });

  it("shows movement since yesterday, closest-to-operable first", () => {
    const { text } = renderReadinessDigest({
      tenants: [
        t("A2Z", 27, 19, { ...FULL, connectors: 0 }),
        t("Upcar", 64, 64, FULL),
      ],
      drafts: [],
      dispatched: 0,
      parked: 2,
    });
    expect(text).toContain("A2Z 19->27");
    expect(text).toMatch(/\+8/);
    expect(text.indexOf("Upcar")).toBeLessThan(text.indexOf("A2Z"));
  });

  it("caps the table but never hides a mover or a tenant with a fresh draft", () => {
    const shells = Array.from({ length: 20 }, (_, i) =>
      t(`Shell${i}`, 30 + i, 30 + i, { ...FULL, connectors: 0 }),
    );
    const { text } = renderReadinessDigest({
      tenants: [
        ...shells,
        t("Mover", 5, 1, { ...FULL, connectors: 0 }),
        t("Drafted", 4, 4, { ...FULL, connectors: 0 }),
      ],
      drafts: [{ tenant_name: "Drafted", canonical_slug: "company", confidence: "low", snippet: "x" }],
      dispatched: 1,
      parked: 21,
    });
    expect(text).toContain("Mover");
    expect(text).toContain("Drafted");
    expect(text).toMatch(/\.\.\. and \d+ more scoring below/);
  });

  it("explains what 'parked' means, so a quiet day is not read as a broken cron", () => {
    const { text } = renderReadinessDigest({
      tenants: [t("Zavi", 58, 58, FULL)],
      drafts: [],
      dispatched: 0,
      parked: 5,
    });
    expect(text).toMatch(/5 parked/);
    expect(text).toMatch(/human-gated/);
  });
});
