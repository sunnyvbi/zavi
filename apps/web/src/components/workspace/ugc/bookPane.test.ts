import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
import { cheapestVideoPackage } from "./CreatorHiringCards";

describe("the book card books the cheapest UGC video package, never a package of another kind", () => {
  it("skips a cheaper old package that is not a UGC video", () => {
    const pick = cheapestVideoPackage([
      { id: "post", kind: "audience_post", price_cents: 4000 },
      { id: "v2", kind: "ugc_video", price_cents: 30000 },
      { id: "v1", kind: "ugc_video", price_cents: 20000 },
    ]);
    expect(pick?.id).toBe("v1");
  });

  it("offers no hire when the creator has no video package", () => {
    expect(cheapestVideoPackage([{ id: "post", kind: "audience_post", price_cents: 4000 }])).toBeNull();
  });
});
