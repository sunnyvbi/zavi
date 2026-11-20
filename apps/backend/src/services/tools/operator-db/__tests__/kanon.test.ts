import { describe, it, expect } from "vitest";
import { classifyReason, bucketReasons, categoryShare, REASON_CATEGORIES } from "../kanon";

describe("classifyReason — owned safe taxonomy", () => {
  it("maps verification-flavored raw reasons to 'verification'", () => {
    expect(classifyReason("KYC document rejected")).toBe("verification");
    expect(classifyReason("identity not verified")).toBe("verification");
    expect(classifyReason("driver license check failed")).toBe("verification");
  });
  it("maps payment/no_show/availability", () => {
    expect(classifyReason("card declined")).toBe("payment");
    expect(classifyReason("guest was a no-show")).toBe("no_show");
    expect(classifyReason("vehicle unavailable / double-booked")).toBe("availability");
  });
  it("free text and empties fall to 'other'", () => {
    expect(classifyReason("the host was kind of rude honestly")).toBe("other");
    expect(classifyReason("")).toBe("other");
    expect(classifyReason(null)).toBe("other");
    expect(classifyReason({ nested: "obj" })).toBe("other");
  });
});

describe("bucketReasons — min-count k-anon", () => {
  it("collapses sub-min NON-other cohorts into 'other'", () => {
    const raw = [
      ...Array(6).fill("verification failed"),
      ...Array(2).fill("card declined"),
      ...Array(3).fill("some rambling free text reason"),
    ];
    const buckets = bucketReasons(raw, 5);
    const byCat = Object.fromEntries(buckets.map((b) => [b.category, b.count]));
    expect(byCat.verification).toBe(6);
    expect(byCat.payment).toBeUndefined();
    expect(byCat.other).toBe(5);
  });

  it("emits ONLY owned taxonomy keys — never a raw reason label (snapshot)", () => {
    const raw = [
      ...Array(8).fill("IDENTITY VERIFICATION could not be completed for user 88213"),
      ...Array(8).fill("payment method was declined, card ending 4242"),
      "a totally unique free-form sentence that must never leak into output",
    ];
    const buckets = bucketReasons(raw, 5);
    const serialized = JSON.stringify(buckets);
    expect(serialized).not.toMatch(/88213|4242|free-form sentence|IDENTITY VERIFICATION/i);
    for (const b of buckets) {
      expect(REASON_CATEGORIES).toContain(b.category);
    }
  });
});

describe("categoryShare", () => {
  it("returns share for a kept category", () => {
    const buckets = bucketReasons([...Array(30).fill("verification"), ...Array(70).fill("card declined")], 5);
    const s = categoryShare(buckets, "verification");
    expect(s?.count).toBe(30);
    expect(s?.total).toBe(100);
    expect(s?.share).toBeCloseTo(0.3);
  });
  it("returns null when the target collapsed below k (→ caller abstains)", () => {
    const buckets = bucketReasons([...Array(2).fill("kyc failed"), ...Array(50).fill("card declined")], 5);
    expect(categoryShare(buckets, "verification")).toBeNull();
  });
});
