
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateCtoShipGate,
  shipBlockExplanation,
  buildShipBlockBody,
  isNoDiffReason,
  collectVerificationNotes,
  appendTestingSection,
  diffMocksModule,
} from "@/agents/engineer/ship-gate";
import { resolveCtoChatIntent } from "@/agents/engineer/intent";

describe("evaluateCtoShipGate — block reasons", () => {
  it("refused envelope → block refused_envelope", () => {
    const r = evaluateCtoShipGate({ refused: true });
    expect(r).toEqual({ shippable: false, reason: "refused_envelope" });
  });

  it("parse_fallback_kind present → block prose_fallback", () => {
    const r = evaluateCtoShipGate({ parse_fallback_kind: "no_envelope_block_prose_fallback" });
    expect(r).toEqual({ shippable: false, reason: "prose_fallback" });
  });

});

describe("evaluateCtoShipGate — shippable cases", () => {
  it("no flags → shippable", () => {
    expect(evaluateCtoShipGate({})).toEqual({ shippable: true });
  });

  it("a legacy envelope still carrying a CTO critic verdict is ignored", () => {
    const r = evaluateCtoShipGate({
      critic: { status: "ok", verdict: "fail", task_match: "mismatch" },
    });
    expect(r).toEqual({ shippable: true });
  });
});

describe("evaluateCtoShipGate — test_results gate", () => {
  it("failed>0 → block tests_failed (fail-closed core)", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 3, failed: 2 }, verify: { status: "failed", attempts: 1 }, risk_class: "low" });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });

  it("failed=0 with passes>0 → shippable, verified", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 12, failed: 0 }, risk_class: "low" });
    expect(r).toEqual({ shippable: true });
  });

  it("no tests run (default 0/0) on non-trivial change → shippable + tests_warning, NOT blocked", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 0, failed: 0 }, risk_class: "low" });
    expect(r).toEqual({
      shippable: true,
      tests_warning: "tests_missing",
    });
  });

  it("absent test_results entirely on non-trivial change → WARN, not block", () => {
    const r = evaluateCtoShipGate({ risk_class: "medium" });
    expect(r).toEqual({
      shippable: true,
      tests_warning: "tests_missing",
    });
  });

  it("risk_class:trivial with failed>0 → EXEMPT (shippable)", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 0, failed: 3 }, verify: { status: "failed", attempts: 1 }, risk_class: "trivial" });
    expect(r).toEqual({ shippable: true });
  });

  it("risk_class:trivial with no tests → EXEMPT, no tests_warning", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 0, failed: 0 }, risk_class: "trivial" });
    expect(r).toEqual({ shippable: true });
  });

  it("absent risk_class is treated as non-trivial → test gate engages", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 0, failed: 4 }, verify: { status: "failed", attempts: 1 } });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });
});

describe("evaluateCtoShipGate — pre-existing reasons STILL block (regression)", () => {
  const greenTests = { test_results: { passed: 5, failed: 0 } };

  it("refused_envelope still blocks (with green tests)", () => {
    const r = evaluateCtoShipGate({ ...greenTests, refused: true, risk_class: "low" });
    expect(r).toEqual({ shippable: false, reason: "refused_envelope" });
  });

  it("prose_fallback still blocks (with green tests)", () => {
    const r = evaluateCtoShipGate({
        ...greenTests,
        parse_fallback_kind: "no_envelope_block_prose_fallback",
        risk_class: "low",
      });
    expect(r).toEqual({ shippable: false, reason: "prose_fallback" });
  });

});

describe("evaluateCtoShipGate — defensive parsing (old / malformed shapes)", () => {
  it("non-object envelope never throws → treated as no flags", () => {
    expect(evaluateCtoShipGate(null)).toEqual({
      shippable: true,
    });
    expect(evaluateCtoShipGate("oops")).toEqual({
      shippable: true,
    });
    expect(evaluateCtoShipGate(42)).toEqual({
      shippable: true,
    });
  });

  it("old stashed envelope (no refused) → shippable, not crash", () => {
    const oldEnvelope = {
      repo: "x/y",
      files: [{ path: "a.ts", action: "modify", content: "z" }],
      pending_pr_proposal: true,
    };
    expect(evaluateCtoShipGate(oldEnvelope)).toEqual({
      shippable: true,
    });
  });

  it("shipBlockExplanation returns a non-empty string for every reason", () => {
    for (const reason of [
      "refused_envelope",
      "prose_fallback",
      "tests_failed",
      "typecheck_failed",
      "tests_missing",
      "wiring_unverified_block",
      "app_verify_missing",
    ] as const) {
      expect(shipBlockExplanation(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveCtoChatIntent", () => {
  it("'what is this issue about?' → info", () => {
    expect(resolveCtoChatIntent("what is this issue about?")).toBe("info");
  });

  it("'fix the refund bug' → ship", () => {
    expect(resolveCtoChatIntent("fix the refund bug")).toBe("ship");
  });

  it("'update me on PR #12' → info", () => {
    expect(resolveCtoChatIntent("update me on PR #12")).toBe("info");
  });

  it("'how does the auth middleware work' → info", () => {
    expect(resolveCtoChatIntent("how does the auth middleware work")).toBe(
      "info",
    );
  });

  it("'add a retry to the webhook handler' → ship", () => {
    expect(resolveCtoChatIntent("add a retry to the webhook handler")).toBe(
      "ship",
    );
  });

  it("'refactor the dispatcher' → ship", () => {
    expect(resolveCtoChatIntent("refactor the dispatcher")).toBe("ship");
  });

  it("'open a PR to bump the SDK version' → ship", () => {
    expect(resolveCtoChatIntent("open a PR to bump the SDK version")).toBe(
      "ship",
    );
  });

  it("'show me the build status, then fix the failing test' (info opener + ship verb) → ambiguous", () => {
    expect(
      resolveCtoChatIntent(
        "show me the build status, then fix the failing test",
      ),
    ).toBe("ambiguous");
  });

  it("'why is this broken and can you change the timeout' (info + ship) → ambiguous", () => {
    expect(
      resolveCtoChatIntent("why is this broken and can you change the timeout"),
    ).toBe("ambiguous");
  });

  it("lone 'status' → info", () => {
    expect(resolveCtoChatIntent("status")).toBe("info");
  });

  it("a bare repo name with no verb → ambiguous (gets full tools)", () => {
    expect(resolveCtoChatIntent("rravi149/praxis")).toBe("ambiguous");
  });

  it("very short input → ambiguous", () => {
    expect(resolveCtoChatIntent("hi")).toBe("ambiguous");
    expect(resolveCtoChatIntent("")).toBe("ambiguous");
  });

  it("word-boundary: 'addition' does not trip ship verb 'add'", () => {
    expect(resolveCtoChatIntent("what is the addition logic here")).toBe(
      "info",
    );
  });
});

describe("resolveCtoChatIntent — agent.md documented examples stay in sync", () => {
  const infoExamples = [
    "what's in the auth module",
    "how does the payout flow work",
    "when did the rate limit change",
    "are there any open PRs",
    "list the last 5 commits",
    "what branches exist",
    "who owns this code",
    "is there a flow for refunds",
    "show me the open PRs",
    "update me on the deploy",
    "find the dispatch handler",
    "check the CI status",
  ];
  for (const ex of infoExamples) {
    it(`Path A example classifies info: "${ex}"`, () => {
      expect(resolveCtoChatIntent(ex)).toBe("info");
    });
  }

  const shipExamples = [
    "add a null check to the parser",
    "fix the timeout in the worker",
    "change the default branch handling",
    "refactor the chat dispatcher",
    "remove the deprecated endpoint",
    "ship a fix for the race condition",
    "wire the new webhook",
    "implement the retry policy",
    "migrate the legacy schema",
  ];
  for (const ex of shipExamples) {
    it(`Path B example classifies ship: "${ex}"`, () => {
      expect(resolveCtoChatIntent(ex)).toBe("ship");
    });
  }
});

describe("resolveCtoChatIntent — P1-1 new ship verbs + regression guards", () => {
  const newShipVerbs = [
    "update the retry policy",
    "rename the helper",
    "replace the deprecated API",
    "delete the dead route",
    "set the default timeout to 30s",
    "enable the new flag",
    "disable the cron",
  ];
  for (const ex of newShipVerbs) {
    it(`new ship verb classifies ship: "${ex}"`, () => {
      expect(resolveCtoChatIntent(ex)).toBe("ship");
    });
  }

  const stillInfo = [
    "update me on PR #12",
    "give me a status update",
    "show me where the rate limit is set",
  ];
  for (const ex of stillInfo) {
    it(`regression guard stays info: "${ex}"`, () => {
      expect(resolveCtoChatIntent(ex)).toBe("info");
    });
  }

  const notShip = [
    "make sense of this stack trace",
    "make sure I understand the checkout flow",
  ];
  for (const ex of notShip) {
    it(`'make'-led turn does not misroute to ship: "${ex}"`, () => {
      expect(resolveCtoChatIntent(ex)).not.toBe("ship");
    });
  }
});

describe("buildShipBlockBody", () => {
  it("folds the diagnosis above the explanation", () => {
    const diagnosis =
      "## Root cause\n`getOptionsForIncidentals` disables the whole row.";
    const body = buildShipBlockBody("tests_failed", { rendered_markdown: diagnosis });
    expect(body).toContain("Root cause");
    expect(body).toContain(shipBlockExplanation("tests_failed"));
    expect(body.indexOf("Root cause")).toBeLessThan(body.indexOf(shipBlockExplanation("tests_failed")));
  });
});

describe("evaluateCtoShipGate — typecheck + wiring", () => {
  const passingTests = { passed: 3, failed: 0 };

  it("typecheck_ok === false → HARD block typecheck_failed", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests, typecheck_ok: false });
    expect(r).toEqual({ shippable: false, reason: "typecheck_failed" });
  });

  it("typecheck_ok === true → not blocked by typecheck", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests, typecheck_ok: true });
    expect(r.shippable).toBe(true);
  });

  it("typecheck_ok absent → fail-open, not blocked (old/non-TS envelope)", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests });
    expect(r.shippable).toBe(true);
  });

  it("typecheck_failed takes precedence over wiring_warning", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests, typecheck_ok: false, wiring_unverified: true });
    expect(r).toEqual({ shippable: false, reason: "typecheck_failed" });
  });

  it("wiring_unverified === true (non-trivial) → SOFT WARN (B1.3: BLOCK_ON_UNWIRED_EXPORTS=false)", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests, wiring_unverified: true });
    expect(r.shippable).toBe(true);
    if (r.shippable) expect(r.wiring_warning).toBe("wiring_unverified");
  });

  it("wiring_unverified === true + risk_class:trivial → SOFT WARN (always, B1.3)", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests, wiring_unverified: true, risk_class: "trivial" });
    expect(r.shippable).toBe(true);
    if (r.shippable) expect(r.wiring_warning).toBe("wiring_unverified");
  });

  it("wiring_unverified absent → no wiring_warning, no block", () => {
    const r = evaluateCtoShipGate({ test_results: passingTests });
    expect(r.shippable).toBe(true);
    if (r.shippable) expect(r.wiring_warning).toBeUndefined();
  });

  it("a red test still blocks tests_failed even when wiring_unverified is set (precedence)", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 0, failed: 2 }, verify: { status: "failed", attempts: 1 }, wiring_unverified: true });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });

  it("typecheck_failed has a human explanation", () => {
    expect(shipBlockExplanation("typecheck_failed")).toMatch(/tsc|typecheck/i);
  });
});

describe("evaluateCtoShipGate — wiring block (1.1) + app_verify gate (1.2)", () => {
  const greenTests = { passed: 3, failed: 0 };

  it("wiring_unverified:true + non-trivial + green tests → WARN not block (B1.3)", () => {
    const r = evaluateCtoShipGate({ test_results: greenTests, wiring_unverified: true, risk_class: "low" });
    expect(r.shippable).toBe(true);
    if (r.shippable) expect(r.wiring_warning).toBe("wiring_unverified");
  });

  it("wiring_unverified:true + risk_class:trivial → shippable (exempt)", () => {
    const r = evaluateCtoShipGate({ test_results: greenTests, wiring_unverified: true, risk_class: "trivial" });
    expect(r.shippable).toBe(true);
  });

  it("wiring_unverified:true + test_results.failed>0 → tests_failed (precedence)", () => {
    const r = evaluateCtoShipGate({ test_results: { passed: 0, failed: 1 }, verify: { status: "failed", attempts: 1 }, wiring_unverified: true, risk_class: "low" });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });

  it("wiring_unverified absent (skipped/ok case) → no block, no wiring_warning", () => {
    const r = evaluateCtoShipGate({ test_results: greenTests, risk_class: "low" });
    expect(r.shippable).toBe(true);
    if (r.shippable) expect(r.wiring_warning).toBeUndefined();
  });

  it("http_route_changed:true + no app_verify_result + non-trivial → app_verify_missing", () => {
    const r = evaluateCtoShipGate({ test_results: greenTests, http_route_changed: true, risk_class: "low" });
    expect(r).toEqual({ shippable: false, reason: "app_verify_missing" });
  });

  it("http_route_changed:true + app_verify_result 200 → shippable", () => {
    const r = evaluateCtoShipGate({
        test_results: greenTests,
        http_route_changed: true,
        app_verify_result: { path: "/x", status: 200 },
        risk_class: "low",
      });
    expect(r.shippable).toBe(true);
  });

  it("http_route_changed:true + app_verify_result 503 (5xx) → app_verify_missing", () => {
    const r = evaluateCtoShipGate({
        test_results: greenTests,
        http_route_changed: true,
        app_verify_result: { path: "/x", status: 503 },
        risk_class: "low",
      });
    expect(r).toEqual({ shippable: false, reason: "app_verify_missing" });
  });

  it("http_route_changed:true + risk_class:trivial → shippable (exempt)", () => {
    const r = evaluateCtoShipGate({ test_results: greenTests, http_route_changed: true, risk_class: "trivial" });
    expect(r.shippable).toBe(true);
  });

  it("http_route_changed unset + no app_verify_result → shippable (non-HTTP unaffected)", () => {
    const r = evaluateCtoShipGate({ test_results: greenTests, risk_class: "low" });
    expect(r.shippable).toBe(true);
  });

  it("wiring WARN + app_verify gate both fire → app_verify_missing blocks (B1.3: wiring is WARN)", () => {
    const r = evaluateCtoShipGate({
        test_results: greenTests,
        wiring_unverified: true,
        http_route_changed: true,
        risk_class: "low",
      });
    expect(r).toEqual({ shippable: false, reason: "app_verify_missing" });
  });

  it("both new reasons have a human explanation", () => {
    expect(shipBlockExplanation("wiring_unverified_block").length).toBeGreaterThan(0);
    expect(shipBlockExplanation("app_verify_missing").length).toBeGreaterThan(0);
  });
});

describe("buildShipBlockBody — wiring_unverified_block", () => {
  it("folds the unwired symbol names + the explanation", () => {
    const body = buildShipBlockBody("wiring_unverified_block", {
      wiring_unwired_symbols: ["deepHealthHandler", "registerDeep"],
    });
    expect(body).toContain("deepHealthHandler");
    expect(body).toContain("registerDeep");
    expect(body).toContain(shipBlockExplanation("wiring_unverified_block"));
  });

  it("no symbols → still returns the explanation, no throw", () => {
    const body = buildShipBlockBody("wiring_unverified_block", {});
    expect(body).toContain(shipBlockExplanation("wiring_unverified_block"));
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

describe("isNoDiffReason — only refused/prose suppress the PR", () => {
  it("refused_envelope + prose_fallback are no-diff (still suppress)", () => {
    expect(isNoDiffReason("refused_envelope")).toBe(true);
    expect(isNoDiffReason("prose_fallback")).toBe(true);
  });
  it("every code-issue reason is NOT no-diff (PR ships anyway)", () => {
    for (const r of [
      "tests_failed",
      "typecheck_failed",
      "tests_missing",
      "wiring_unverified_block",
      "app_verify_missing",
    ] as const) {
      expect(isNoDiffReason(r)).toBe(false);
    }
  });
});

describe("collectVerificationNotes — Testing section content", () => {
  it("the exact Slack failure: route change + no app_verify result + green tests → ONE app_verify note (not a block)", () => {
    const notes = collectVerificationNotes({
        risk_class: "medium",
        test_results: { passed: 3, failed: 0 },
        typecheck_ok: true,
        http_route_changed: true,
      });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("app_verify");
    expect(notes[0].toLowerCase()).toContain("could not run");
  });

  it("app_verify ran and got a 5xx → a 'returned HTTP 5xx' note (real signal)", () => {
    const notes = collectVerificationNotes({
        risk_class: "medium",
        test_results: { passed: 1, failed: 0 },
        typecheck_ok: true,
        http_route_changed: true,
        app_verify_result: { path: "/api/x", status: 502 },
      });
    expect(notes.some((n) => n.includes("502"))).toBe(true);
  });

  it("app_verify served non-5xx → no app_verify note", () => {
    const notes = collectVerificationNotes({
        risk_class: "medium",
        test_results: { passed: 1, failed: 0 },
        typecheck_ok: true,
        http_route_changed: true,
        app_verify_result: { path: "/api/x", status: 200 },
      });
    expect(notes.some((n) => n.includes("app_verify"))).toBe(false);
  });

  it("red tests + red typecheck both surface as notes", () => {
    const notes = collectVerificationNotes({ risk_class: "medium", test_results: { passed: 0, failed: 2 }, verify: { status: "failed", attempts: 1 }, typecheck_ok: false });
    expect(notes.some((n) => n.toLowerCase().includes("tests:"))).toBe(true);
    expect(notes.some((n) => n.toLowerCase().includes("typecheck"))).toBe(true);
  });

  it("clean run (green tests, typecheck ok, no route change) → no notes", () => {
    const notes = collectVerificationNotes({ risk_class: "low", test_results: { passed: 5, failed: 0 }, typecheck_ok: true });
    expect(notes).toEqual([]);
  });

  it("defensive on garbage input — never throws", () => {
    expect(() => collectVerificationNotes(null)).not.toThrow();
    expect(() => collectVerificationNotes("nope")).not.toThrow();
  });
});

describe("appendTestingSection", () => {
  it("empty notes → body unchanged", () => {
    expect(appendTestingSection("hello", [])).toBe("hello");
  });
  it("non-empty notes → appends a Testing & verification section", () => {
    const out = appendTestingSection("PR body", ["check A", "check B"]);
    expect(out).toContain("PR body");
    expect(out).toContain("## Testing & verification");
    expect(out).toContain("- check A");
    expect(out).toContain("- check B");
  });
  it("non-string body → section only", () => {
    const out = appendTestingSection(undefined, ["only note"]);
    expect(out).toContain("## Testing & verification");
    expect(out).toContain("only note");
  });
  it("never exceeds the body cap, and preserves the Testing section (trims base)", () => {
    const hugeBody = "x".repeat(9000);
    const out = appendTestingSection(hugeBody, ["important verification note"], 8000);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out).toContain("## Testing & verification");
    expect(out).toContain("important verification note");
  });
});

const okProposal = { risk_class: "low", test_results: { passed: 1, failed: 0 } };

describe("evaluateCtoShipGate — diagnosis gates", () => {
  it("#1763 replay: diagnosis blames a dep AND the test mocks it → mocked_suspect", () => {
    const r = evaluateCtoShipGate({
        ...okProposal,
        diagnosis: { root_cause_symbol: "@supabase/ssr", reproduced: true },
        files: [
          {
            path: "apps/web/src/lib/supabase.test.ts",
            content: 'vi.mock("@supabase/ssr", () => ({ createBrowserClient: vi.fn() }));',
          },
        ],
      });
    expect(r).toEqual({ shippable: false, reason: "mocked_suspect" });
  });

  it("mocked_suspect fires even when reproduced=true (a mocked repro is not a repro)", () => {
    const r = evaluateCtoShipGate({
        ...okProposal,
        diagnosis: { root_cause_symbol: "@supabase/ssr", reproduced: true },
        files: [{ path: "x.spec.ts", content: 'jest.mock("@supabase/ssr")' }],
      });
    expect(r).toEqual({ shippable: false, reason: "mocked_suspect" });
  });

  it("bugfix diagnosis, not reproduced, no reason → diagnosis_unreproduced", () => {
    const r = evaluateCtoShipGate({ ...okProposal, diagnosis: { root_cause_symbol: "src/lib/foo.ts" } });
    expect(r).toEqual({ shippable: false, reason: "diagnosis_unreproduced" });
  });

  it("bugfix diagnosis, reproduced=true → shippable", () => {
    const r = evaluateCtoShipGate({ ...okProposal, diagnosis: { root_cause_symbol: "foo", reproduced: true } });
    expect(r).toEqual({ shippable: true });
  });

  it("not reproduced BUT honest not_reproduced_reason → shippable (escape hatch)", () => {
    const r = evaluateCtoShipGate({
        ...okProposal,
        diagnosis: {
          root_cause_symbol: "webhookHandler",
          reproduced: false,
          not_reproduced_reason: "needs a live Stripe webhook the sandbox can't fire",
        },
      });
    expect(r).toEqual({ shippable: true });
  });

  it("no diagnosis block (feature/refactor) → gates inert, shippable", () => {
    const r = evaluateCtoShipGate({ ...okProposal, files: [{ path: "x.test.ts", content: 'vi.mock("lodash")' }] });
    expect(r).toEqual({ shippable: true });
  });

  it("mocked_suspect takes precedence over diagnosis_unreproduced", () => {
    const r = evaluateCtoShipGate({
        ...okProposal,
        diagnosis: { root_cause_symbol: "@supabase/ssr" },
        files: [{ path: "a.test.ts", content: 'vi.mock("@supabase/ssr")' }],
      });
    expect(r).toEqual({ shippable: false, reason: "mocked_suspect" });
  });

  it("trivial risk_class is exempt from diagnosis gates", () => {
    const r = evaluateCtoShipGate({
        risk_class: "trivial",
        test_results: { passed: 0, failed: 0 },
        diagnosis: { root_cause_symbol: "foo" },
      });
    expect(r).toEqual({ shippable: true });
  });

  it("tests_failed still wins precedence over the diagnosis gates", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        test_results: { passed: 0, failed: 2 }, verify: { status: "failed", attempts: 1 },
        diagnosis: { root_cause_symbol: "@supabase/ssr" },
        files: [{ path: "a.test.ts", content: 'vi.mock("@supabase/ssr")' }],
      });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });
});

describe("diffMocksModule — cheat-proof mock scan", () => {
  it("ignores a mock in a NON-test file", () => {
    expect(
      diffMocksModule([{ path: "src/real.ts", content: 'vi.mock("@supabase/ssr")' }], "@supabase/ssr"),
    ).toBe(false);
  });

  it("matches vi.mock, jest.mock and vitest.mock in a test file", () => {
    for (const call of ["vi.mock", "jest.mock", "vitest.mock"]) {
      expect(
        diffMocksModule([{ path: "a.test.ts", content: `${call}("@supabase/ssr")` }], "@supabase/ssr"),
      ).toBe(true);
    }
  });

  it("matches on the diff field too, not just content", () => {
    expect(
      diffMocksModule([{ path: "a.test.ts", diff: '+vi.mock("@supabase/ssr")' }], "@supabase/ssr"),
    ).toBe(true);
  });

  it("does NOT false-positive a short suspect against an unrelated mock", () => {
    expect(
      diffMocksModule([{ path: "a.test.ts", content: 'vi.mock("@supabase/ssr")' }], "fs"),
    ).toBe(false);
  });

  it("empty suspect or non-array files → false", () => {
    expect(diffMocksModule([{ path: "a.test.ts", content: 'vi.mock("x")' }], "")).toBe(false);
    expect(diffMocksModule(undefined, "@supabase/ssr")).toBe(false);
  });
});

describe("diagnosis — explanations + verification notes", () => {
  it("shipBlockExplanation covers both new reasons", () => {
    expect(shipBlockExplanation("mocked_suspect")).toMatch(/mocks the very dependency/i);
    expect(shipBlockExplanation("diagnosis_unreproduced")).toMatch(/never reproduced the symptom/i);
  });

  it("mocked_suspect verification note names the blamed dependency", () => {
    const notes = collectVerificationNotes({
        ...okProposal,
        diagnosis: { root_cause_symbol: "@supabase/ssr" },
        files: [{ path: "a.test.ts", content: 'vi.mock("@supabase/ssr")' }],
      });
    expect(notes.some((n) => /mocks `@supabase\/ssr`/.test(n))).toBe(true);
  });

  it("unreproduced-with-reason note surfaces the reason", () => {
    const notes = collectVerificationNotes({
        ...okProposal,
        diagnosis: { root_cause_symbol: "x", not_reproduced_reason: "needs prod data" },
      });
    expect(notes.some((n) => /NOT reproduced.*needs prod data/i.test(n))).toBe(true);
  });

  it("omit-dodge: causal-language body with NO diagnosis block → soft note only", () => {
    const notes = collectVerificationNotes({ ...okProposal, body: "This fixes the login bug. The root cause is a stale cache." });
    expect(notes.some((n) => /reads like a bug fix.*no structured diagnosis/i.test(n))).toBe(true);
  });

  it("no causal language + no diagnosis → no diagnosis note", () => {
    const notes = collectVerificationNotes({ ...okProposal, body: "Add a new /widgets endpoint." });
    expect(notes.some((n) => /diagnosis/i.test(n))).toBe(false);
  });
});

describe("evaluateCtoShipGate — trust receipt (model cannot fake a green suite)", () => {

  it("model self-reports ALL GREEN but the run_tests receipt says failed → HARD BLOCK", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        test_results: { passed: 12, failed: 0 },
        verify: { status: "failed", reason: "exit 1", attempts: 1 },
      });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });

  it("model self-reports RED but the receipt says passed → the receipt wins, ships", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        test_results: { passed: 0, failed: 9 },
        verify: { status: "passed", attempts: 1 },
      });
    expect(r.shippable).toBe(true);
  });

  it("receipt ABSENT (legacy stashed envelope) → NO hard block, even with model-red", () => {
    const r = evaluateCtoShipGate({ risk_class: "low", test_results: { passed: 0, failed: 3 } });
    expect(r.shippable).toBe(true);
  });

  it("receipt says not_run → shippable but annotated tests_missing (soft)", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        test_results: { passed: 5, failed: 0 },
        verify: { status: "not_run", attempts: 0 },
      });
    expect(r.shippable).toBe(true);
    if (r.shippable) expect(r.tests_warning).toBe("tests_missing");
  });

  it("receipt says couldnt_run → shippable, annotated (fail-open on the unknowable)", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        test_results: { passed: 0, failed: 0 },
        verify: { status: "couldnt_run", reason: "no test runner", attempts: 1 },
      });
    expect(r.shippable).toBe(true);
  });

  it("risk_class:trivial stays EXEMPT even with a red receipt", () => {
    const r = evaluateCtoShipGate({
        risk_class: "trivial",
        verify: { status: "failed", attempts: 1 },
      });
    expect(r.shippable).toBe(true);
  });
});

describe("evaluateCtoShipGate — test attribution", () => {
  const red = { risk_class: "low", verify: { status: "failed", attempts: 1 } };

  it("agent BROKE a passing test → tests_failed_new (the strong block)", () => {
    const r = evaluateCtoShipGate({
        ...red,
        test_attribution: {
          kind: "attributed",
          new_failures: ["auth::expired"],
          pre_existing: ["old::1"],
        },
      });
    expect(r).toEqual({ shippable: false, reason: "tests_failed_new" });
  });

  it("red, but EVERY failure was already failing on base → SHIPPABLE (the Apna case)", () => {
    const r = evaluateCtoShipGate({
        ...red,
        test_attribution: {
          kind: "attributed",
          new_failures: [],
          pre_existing: ["a::1", "a::2", "a::3"],
        },
      });
    expect(r.shippable).toBe(true);
  });

  it("red but attribution UNKNOWN → tests_failed (warn, today's behavior) — never the strong block", () => {
    const r = evaluateCtoShipGate({ ...red, test_attribution: { kind: "unknown", why: "could not enumerate" } });
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });

  it("red with NO attribution at all (legacy envelope) → tests_failed (warn)", () => {
    const r = evaluateCtoShipGate(red);
    expect(r).toEqual({ shippable: false, reason: "tests_failed" });
  });

  it("risk_class trivial stays exempt even when the agent broke a test", () => {
    const r = evaluateCtoShipGate({
        risk_class: "trivial",
        verify: { status: "failed", attempts: 1 },
        test_attribution: { kind: "attributed", new_failures: ["x::1"], pre_existing: [] },
      });
    expect(r.shippable).toBe(true);
  });
});

describe("evaluateCtoShipGate — F1/F13: server typecheck receipt beats the model field", () => {

  it("F13: a forged typecheck_ok:true does NOT slip a server-FAILED typecheck", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        verify: { status: "passed", attempts: 1 },
        typecheck_ok: true,
        typecheck_verify: { status: "failed", attempts: 1 },
      });
    expect(r).toEqual({ shippable: false, reason: "typecheck_failed" });
  });

  it("a server-PASSED typecheck clears a model typecheck_ok:false (the real exit wins)", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        verify: { status: "passed", attempts: 1 },
        typecheck_ok: false,
        typecheck_verify: { status: "passed", attempts: 1 },
      });
    expect(r).not.toEqual({ shippable: false, reason: "typecheck_failed" });
  });

  it("falls back to model typecheck_ok:false when the server saw no typecheck (old behavior preserved)", () => {
    const r = evaluateCtoShipGate({ risk_class: "low", verify: { status: "passed", attempts: 1 }, typecheck_ok: false });
    expect(r).toEqual({ shippable: false, reason: "typecheck_failed" });
  });

  it("a server couldnt_run does NOT fabricate a block when the model says typecheck_ok:true", () => {
    const r = evaluateCtoShipGate({
        risk_class: "low",
        verify: { status: "passed", attempts: 1 },
        typecheck_ok: true,
        typecheck_verify: { status: "couldnt_run", attempts: 1 },
      });
    expect(r).not.toEqual({ shippable: false, reason: "typecheck_failed" });
  });
});
