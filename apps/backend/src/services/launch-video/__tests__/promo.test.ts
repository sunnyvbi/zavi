import { describe, it, expect } from "vitest";
import { intakeToVideoBrief, launchVideoIntakeSchema, type LaunchVideoIntake } from "../brief-mapper";
import { lintVideoBrief, isOutwardClaimType } from "../lint";

const promoBase: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Your July 4th ride is here.",
  url: "https://upcar.ai",
  audience: "people planning a July 4th road trip",
  tone: "bold",
  video_type: "promo",
  features: [
    { title: "Book in two minutes", detail: "Find a car near you and reserve it instantly." },
    { title: "Real local hosts", detail: "Thousands of cars from real people in your city." },
  ],
  cta_text: "Find a car near you",
  cta_url: "https://upcar.ai",
  festival: "July 4th",
  coupon: { code: "UPCARJULY4TH", discount_label: "$30 off your trip", expiry_label: "Ends July 25, 2026" },
};

describe("promo — outward-claim posture", () => {
  it("promo is an outward-claim type (fail-closed lint gate)", () => {
    expect(isOutwardClaimType("promo")).toBe(true);
  });
});

describe("promo — coupon drives the CTA", () => {
  it("discount is the CTA headline; code + expiry are the chips (uppercased)", () => {
    const cta = intakeToVideoBrief(promoBase).beats.at(-1)!;
    expect(cta.kind).toBe("cta");
    const c = cta as { headline?: string; chips?: string[] };
    expect(c.headline).toBe("$30 off your trip");
    expect(c.chips).toEqual(["CODE: UPCARJULY4TH", "ENDS JULY 25, 2026"]);
  });

  it("without a coupon, promo falls back to cta_text (no crash, no coupon chips)", () => {
    const { coupon, ...noCoupon } = promoBase;
    const cta = intakeToVideoBrief(noCoupon).beats.at(-1)! as { headline?: string; chips?: string[] };
    expect(cta.headline).toBe("Find a car near you");
    expect(cta.chips ?? []).not.toContain("CODE: UPCARJULY4TH");
  });

  it("mapper defensively ignores a coupon on a non-promo type (never renders the offer)", () => {
    const cta = intakeToVideoBrief({ ...promoBase, video_type: "ad" }).beats.at(-1)! as { headline?: string };
    expect(cta.headline).toBe("Find a car near you");
  });
});

describe("promo — schema rejects a coupon on the wrong video_type", () => {
  it("coupon + video_type 'promo' parses", () => {
    expect(launchVideoIntakeSchema.safeParse(promoBase).success).toBe(true);
  });
  it("coupon + video_type 'ad' is REJECTED (not silently dropped)", () => {
    const r = launchVideoIntakeSchema.safeParse({ ...promoBase, video_type: "ad" });
    expect(r.success).toBe(false);
  });
  it("a promo with NO coupon parses (coupon is optional)", () => {
    const { coupon, ...noCoupon } = promoBase;
    expect(launchVideoIntakeSchema.safeParse(noCoupon).success).toBe(true);
  });
});

describe("promo — festival suitability lint", () => {
  it("a clean July 4th coupon promo passes", () => {
    const r = lintVideoBrief(intakeToVideoBrief(promoBase), "promo", { festival: promoBase.festival });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("blocks a discount promo on a remembrance day (festival field)", () => {
    const brief = intakeToVideoBrief({ ...promoBase, festival: "Juneteenth", one_liner: "Celebrate this weekend." });
    const r = lintVideoBrief(brief, "promo", { festival: "Juneteenth" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("promo.inappropriate_festival");
  });

  it("blocks even when the somber day is named only in the on-screen copy", () => {
    const brief = intakeToVideoBrief({ ...promoBase, festival: undefined, one_liner: "Honor our veterans this Veterans Day." });
    const r = lintVideoBrief(brief, "promo");
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("promo.inappropriate_festival");
  });

  it("catches punctuation/spelling variants (Veteran's Day, September 11th, 9-11)", () => {
    for (const f of ["Veteran's Day", "September 11th", "9-11", "MLK Jr. Day"]) {
      const r = lintVideoBrief(intakeToVideoBrief({ ...promoBase, festival: f, one_liner: "A promo." }), "promo", { festival: f });
      expect(r.violations.map((v) => v.code), f).toContain("promo.inappropriate_festival");
    }
  });

  it("allows a Memorial Day WEEKEND travel promo (not the remembrance framing)", () => {
    const brief = intakeToVideoBrief({ ...promoBase, festival: "Memorial Day weekend", one_liner: "Memorial Day weekend road trip is calling." });
    const r = lintVideoBrief(brief, "promo", { festival: "Memorial Day weekend" });
    expect(r.violations.map((v) => v.code)).not.toContain("promo.inappropriate_festival");
  });

  it("warns (caveat, not block) on a restrained/religious solemn festival", () => {
    const brief = intakeToVideoBrief({ ...promoBase, festival: "Ramadan", one_liner: "Travel home this Ramadan." });
    const r = lintVideoBrief(brief, "promo", { festival: "Ramadan" });
    expect(r.violations.map((v) => v.code)).not.toContain("promo.inappropriate_festival");
    expect(r.caveats.join(" ")).toMatch(/restrained/i);
  });
});
