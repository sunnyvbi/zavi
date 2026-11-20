import { describe, it, expect } from "vitest";
import {
  verifyEngineerTestClaim,
  ENGINEER_VERIFY_VALIDATOR_AGENTS,
} from "../engineer-unverified-claim-verifier";

const SHIPPED = { side_effect_kind: "shipped" } as const;

describe("verifyEngineerTestClaim", () => {
  it("passed receipt + claim → untouched (claim is grounded)", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Fixed the bug and all tests pass. Opening a PR.",
      verify: { status: "passed" },
    });
    expect(r.hedged).toBe(false);
    expect(r.text).not.toContain("Correction");
  });

  it("not_run receipt + 'all tests pass' claim → hedged with honest correction", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Fixed it — all tests pass. PR incoming.",
      verify: { status: "not_run" },
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("Correction");
    expect(r.text).toContain("didn't run the tests");
    expect(r.text).toContain("Fixed it");
  });

  it("failed receipt + 'tested and it works' claim → hedged with 'did not pass'", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "I tested and it works now.",
      verify: { status: "failed" },
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("did not pass");
  });

  it("couldnt_run receipt + 'verified it works' claim → hedged, surfaces the reason", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "I verified it works end to end.",
      verify: { status: "couldnt_run", reason: "mongodb-memory-server download failed" },
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("couldn't run the tests");
    expect(r.text).toContain("mongodb-memory-server");
  });

  it("no verify claim in the reply → untouched even when not passed", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Here's a change to the users model. Opening a PR for review.",
      verify: { status: "not_run" },
    });
    expect(r.hedged).toBe(false);
  });

  it("missing/undefined verify → treated as not_run; a claim is hedged", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED, reply: "Done, tests are green.", verify: undefined });
    expect(r.hedged).toBe(true);
  });

  it("hedges an unsupported numeric test claim", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Tests: 225/225 passed.",
      verify: { status: "not_run" },
    });
    expect(r.hedged).toBe(true);
    expect(r.text).not.toContain("225/225 passed");
    expect(r.text).toContain("didn't run the tests");
  });

  it("idempotent — a reply already carrying the banner marker is not double-bannered", () => {
    const once = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "all tests pass",
      verify: { status: "not_run" },
    });
    expect(once.hedged).toBe(true);
    const twice = verifyEngineerTestClaim({ ...SHIPPED, reply: once.text, verify: { status: "not_run" } });
    expect(twice.hedged).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("engineer is the only gated agent", () => {
    expect(ENGINEER_VERIFY_VALIDATOR_AGENTS.has("engineer")).toBe(true);
    expect(ENGINEER_VERIFY_VALIDATOR_AGENTS.has("operator")).toBe(false);
    expect(ENGINEER_VERIFY_VALIDATOR_AGENTS.has("pm")).toBe(false);
  });
});

describe("verifyEngineerTestClaim — stale committed dist (apna-tutor PR #76)", () => {
  const staleStamp = [
    { pkgRoot: "apps/backend", srcFiles: ["apps/backend/src/controller/tutorController.ts"] },
  ];

  it("fires the PR-#76 shape: passing tests + a bare 'fixed' claim still get the banner", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Fixed it — the banner now reads correctly. Opened PR #76.",
      verify: { status: "passed" },
      pr_url: "https://github.com/rravi149/apna-tutor/pull/76",
      stale_committed_dist: staleStamp,
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("Correction");
    expect(r.text).toContain("`apps/backend`");
    expect(r.text).toContain("did NOT regenerate");
    expect(r.text).toContain("Fixed it");
    expect(r.matched_phrases).toEqual(["stale_committed_dist"]);
  });

  it("wording is CONDITIONAL — never asserts the change WILL run stale", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Done.",
      verify: { status: "passed" },
      stale_committed_dist: staleStamp,
    });
    expect(r.text).toContain("If this repo deploys the committed");
    expect(r.text).not.toContain("will run STALE");
  });

  it("empty / absent stamp → falls through to normal behavior (untouched)", () => {
    const r = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Fixed it and opened a PR.",
      verify: { status: "passed" },
      stale_committed_dist: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("idempotent across seams — the second pass sees the marker and no-ops", () => {
    const once = verifyEngineerTestClaim({ ...SHIPPED,
      reply: "Fixed it.",
      verify: { status: "passed" },
      stale_committed_dist: staleStamp,
    });
    expect(once.hedged).toBe(true);
    const twice = verifyEngineerTestClaim({ ...SHIPPED,
      reply: once.text,
      verify: { status: "passed" },
      stale_committed_dist: staleStamp,
    });
    expect(twice.hedged).toBe(false);
    expect(twice.text).toBe(once.text);
  });
});

describe("verifyEngineerTestClaim — only a run that shipped can be corrected", () => {
  it("a REFUSED run stays silent, even with an unsupported test claim", () => {
    const r = verifyEngineerTestClaim({
      reply: "I checked the repo and all tests pass, but this is the wrong repo.",
      verify: { status: "not_run" },
      side_effect_kind: "refused",
    });
    expect(r.hedged).toBe(false);
    expect(r.text).not.toContain("Correction");
  });

  it("a no-change run stays silent, stale-dist stamp included", () => {
    const r = verifyEngineerTestClaim({
      reply: "Done, tests are green.",
      verify: { status: "not_run" },
      side_effect_kind: "none",
      stale_committed_dist: [{ pkgRoot: "apps/backend" }],
    });
    expect(r.hedged).toBe(false);
  });

  it("no stamp and no PR receipt stays silent", () => {
    const r = verifyEngineerTestClaim({ reply: "all tests pass", verify: { status: "not_run" } });
    expect(r.hedged).toBe(false);
  });

  it("a real PR receipt still gets the honest correction without a stamp", () => {
    const r = verifyEngineerTestClaim({
      reply: "all tests pass",
      verify: { status: "not_run" },
      pr_url: "https://github.com/acme/web/pull/812",
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("The PR is open");
  });
});
