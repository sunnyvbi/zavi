import { describe, expect, it } from "vitest";
import { verifyEngineerTestClaim } from "../engineer-unverified-claim-verifier";

const CLAIMING_REPLY = "All tests pass, so the fix stays sound.";

describe("correction banner — the PR clause requires a real PR receipt", () => {
  it("the 131bf466 case (an audit that shipped nothing) gets no banner at all", () => {
    const ev = verifyEngineerTestClaim({
      reply: CLAIMING_REPLY,
      verify: { status: "not_run" },
    });
    expect(ev.hedged).toBe(false);
    expect(ev.text).toBe(CLAIMING_REPLY);
  });

  it("does NOT claim a PR on a shipped run with no pr_url", () => {
    const ev = verifyEngineerTestClaim({
      reply: CLAIMING_REPLY,
      verify: { status: "not_run" },
      side_effect_kind: "shipped",
    });
    expect(ev.hedged).toBe(true);
    expect(ev.text).not.toMatch(/the pr is open/i);
    expect(ev.text).toMatch(/verify this yourself/i);
  });

  it("does NOT claim a PR when pr_url is null or blank", () => {
    for (const pr_url of [null, undefined, "", "   "]) {
      const ev = verifyEngineerTestClaim({
        reply: CLAIMING_REPLY,
        verify: { status: "failed" },
        pr_url,
        side_effect_kind: "shipped",
      });
      expect(ev.text).not.toMatch(/the pr is open/i);
    }
  });

  it("DOES point at the PR when a real pr_url receipt exists", () => {
    const ev = verifyEngineerTestClaim({
      reply: CLAIMING_REPLY,
      verify: { status: "failed" },
      pr_url: "https://github.com/rravi149/upcar/pull/1159",
    });
    expect(ev.hedged).toBe(true);
    expect(ev.text).toMatch(/the pr is open with your change/i);
  });

  it("still corrects the underlying false test claim either way", () => {
    const noPr = verifyEngineerTestClaim({
      reply: CLAIMING_REPLY,
      verify: { status: "failed" },
      side_effect_kind: "shipped",
    });
    expect(noPr.text).toMatch(/did not pass/i);
    expect(noPr.matched_phrases.length).toBeGreaterThan(0);
  });

  it("a real exit-0 pass is still never rewritten", () => {
    const ev = verifyEngineerTestClaim({
      reply: CLAIMING_REPLY,
      verify: { status: "passed" },
    });
    expect(ev.hedged).toBe(false);
    expect(ev.text).toBe(CLAIMING_REPLY);
  });
});
