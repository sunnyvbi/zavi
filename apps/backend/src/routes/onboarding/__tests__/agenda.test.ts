
import { describe, it, expect } from "vitest";
import { computeAgenda, validateEchoedAgenda } from "../chat";

function ok(pages: Array<{ url: string; title?: string; text_excerpt?: string }>) {
  return { status: "ok" as const, domain_pages: pages, app_listings: [] };
}
const STRONG_ABOUT =
  "Our story: we founded this company in 2019 because the market was broken. " +
  "Why we built it — to fix the thing nobody else would. ".repeat(6);

const STRONG_SUPPLY =
  "Become a host on our platform. List your space and earn. Our hosts come from all over. " +
  "Join as a seller today and start hosting. ".repeat(6);

describe("computeAgenda — broad-skip (SHADOW mode by default)", () => {
  it("strong SUPPLY page does NOT drop SUPPLY while BROAD_SKIP is shadow (no false-skip live)", () => {
    const a = computeAgenda("marketplace", ok([
      { url: "https://acme.com/sell", title: "Become a host", text_excerpt: STRONG_SUPPLY },
    ]));
    expect(a.map((t) => t.key)).toContain("SUPPLY");
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("false-positive /sell-your-privacy does NOT cover SUPPLY (negative pattern)", () => {
    const a = computeAgenda("marketplace", ok([
      { url: "https://acme.com/sell-your-privacy", text_excerpt: "x".repeat(400) },
    ]));
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("MONEY is never skippable even with a strong pricing-ish page", () => {
    const a = computeAgenda("marketplace", ok([
      { url: "https://acme.com/sell", title: "Become a host", text_excerpt: STRONG_SUPPLY },
    ]));
    expect(a.map((t) => t.key)).toContain("MONEY");
  });
});

describe("computeAgenda — narrow ORIGIN-only skip", () => {
  it("no enrichment → full per-shape agenda (3 topics)", () => {
    const a = computeAgenda("marketplace", null);
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("status:skipped → full agenda", () => {
    const a = computeAgenda("saas", { status: "skipped", reason: "feature_flag_off" } as never);
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "ICP", "PRICING"]);
  });

  it("ok but no /about page → no skip", () => {
    const a = computeAgenda("marketplace", ok([{ url: "https://x.com/pricing", text_excerpt: STRONG_ABOUT }]));
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("strong /about → ORIGIN dropped (first topic becomes SUPPLY)", () => {
    const a = computeAgenda("marketplace", ok([{ url: "https://x.com/about", title: "About us", text_excerpt: STRONG_ABOUT }]));
    expect(a.map((t) => t.key)).toEqual(["SUPPLY", "MONEY"]);
  });

  it("/about-us also triggers skip", () => {
    const a = computeAgenda("saas", ok([{ url: "https://x.com/about-us", text_excerpt: STRONG_ABOUT }]));
    expect(a.map((t) => t.key)).toEqual(["ICP", "PRICING"]);
  });

  it("/about with <250 chars → NO skip (weak signal)", () => {
    const a = computeAgenda("marketplace", ok([{ url: "https://x.com/about", text_excerpt: "We founded this. Our story." }]));
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("homepage `/` with founding copy → NO skip (never the homepage)", () => {
    const a = computeAgenda("marketplace", ok([{ url: "https://x.com/", title: "Home", text_excerpt: STRONG_ABOUT }]));
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("/about present but no founding signal → NO skip", () => {
    const noSignal = "Contact us at our office. Hours 9-5. ".repeat(10);
    const a = computeAgenda("marketplace", ok([{ url: "https://x.com/about", text_excerpt: noSignal }]));
    expect(a.map((t) => t.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("floor ≥1 — result always has at least one topic", () => {
    for (const shape of ["marketplace", "saas", "ecommerce", "services", "fintech", "other"]) {
      expect(computeAgenda(shape, ok([{ url: "https://x.com/about", text_excerpt: STRONG_ABOUT }])).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("validateEchoedAgenda — deduped canonical-ordered legal-for-shape subset", () => {
  it("full in-order agenda → mapped topics", () => {
    const t = validateEchoedAgenda("marketplace", ["ORIGIN", "SUPPLY", "MONEY"]);
    expect(t?.map((x) => x.key)).toEqual(["ORIGIN", "SUPPLY", "MONEY"]);
  });

  it("proper post-skip subset (ORIGIN dropped) → mapped", () => {
    const t = validateEchoedAgenda("marketplace", ["SUPPLY", "MONEY"]);
    expect(t?.map((x) => x.key)).toEqual(["SUPPLY", "MONEY"]);
  });

  it("single key → mapped", () => {
    expect(validateEchoedAgenda("marketplace", ["MONEY"])?.map((x) => x.key)).toEqual(["MONEY"]);
  });

  it("duplicate keys → null", () => {
    expect(validateEchoedAgenda("marketplace", ["MONEY", "MONEY"])).toBeNull();
  });

  it("reordered (non-canonical) → null", () => {
    expect(validateEchoedAgenda("marketplace", ["MONEY", "SUPPLY"])).toBeNull();
  });

  it("cross-shape key injection → null", () => {
    expect(validateEchoedAgenda("marketplace", ["ICP"])).toBeNull();
    expect(validateEchoedAgenda("marketplace", ["ORIGIN", "REGULATION"])).toBeNull();
  });

  it("empty array → null", () => {
    expect(validateEchoedAgenda("marketplace", [])).toBeNull();
  });

  it("non-array / non-string → null", () => {
    expect(validateEchoedAgenda("marketplace", undefined)).toBeNull();
    expect(validateEchoedAgenda("marketplace", "ORIGIN")).toBeNull();
    expect(validateEchoedAgenda("marketplace", [1, 2] as never)).toBeNull();
  });
});
