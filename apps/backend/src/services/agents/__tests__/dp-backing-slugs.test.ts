import { describe, it, expect } from "vitest";
import { dpBackingSlugsForFamilies } from "../chat-dispatcher";
import { deferredPromiseFamilies } from "../receipt-verifier";

describe("dpBackingSlugsForFamilies — which running work can back a promise", () => {
  it("a PR promise is backed only by the engineer", () => {
    expect(dpBackingSlugsForFamilies(["pr"])).toEqual(["engineer"]);
  });

  it("a running qa run must NOT back a PR promise", () => {
    expect(dpBackingSlugsForFamilies(["pr"])).not.toContain("qa");
  });

  it("a 'post' promise is ALSO backed by the engineer", () => {
    expect(dpBackingSlugsForFamilies(["post"])).toEqual(["engineer"]);
  });

  it("'email' has no registered backer — it still relies on this turn's tools", () => {
    expect(dpBackingSlugsForFamilies(["email"])).toEqual([]);
  });

  it("end-to-end: the reported reply resolves to a backer (would have caught the wiring bug)", () => {
    const REPORTED =
      "The engineer is already working on this — run dccb57f2 is in flight and " +
      "will open the PR when done. I'll post the link here as soon as it lands.";
    const families = deferredPromiseFamilies(REPORTED);
    expect(families.length, "reply must be detected as a promise").toBeGreaterThan(0);
    expect(families).toContain("post");
    expect(dpBackingSlugsForFamilies(families)).toContain("engineer");
  });

  it("no families → no slugs (caller skips the lookup entirely)", () => {
    expect(dpBackingSlugsForFamilies([])).toEqual([]);
  });

  it("dedupes across families and ignores unknown ones", () => {
    expect(dpBackingSlugsForFamilies(["pr", "pr", "nonsense"])).toEqual(["engineer"]);
  });
});
