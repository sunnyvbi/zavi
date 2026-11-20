import { describe, it, expect, vi } from "vitest";

vi.mock("../client", () => ({ inngest: { createFunction: vi.fn(() => ({})) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn() }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import {
  registrableDomain,
  rewriteSpecUrlsToStaging,
  parseQaVerdict,
  buildWeeklyDigest,
  type QaVerdict,
} from "../qa-weekly-execute";

const STAGING = "https://www.apnatutor.live";

describe("registrableDomain", () => {
  it("collapses subdomains to the last two labels", () => {
    expect(registrableDomain("latest.apnatutor.live")).toBe("apnatutor.live");
    expect(registrableDomain("www.apnatutor.live")).toBe("apnatutor.live");
    expect(registrableDomain("apnatutor.live")).toBe("apnatutor.live");
    expect(registrableDomain("accounts.google.com")).toBe("google.com");
  });
});

describe("rewriteSpecUrlsToStaging (S2)", () => {
  it("rewrites same-product subdomain URLs to the staging origin, keeping path+query", () => {
    const spec = {
      steps: [
        "Navigate to https://latest.apnatutor.live/signup?role=tutor",
        "Read the page heading",
      ],
      expected_outcome: "Signup form renders",
      preconditions: [],
    };
    const { spec: out, rewrites } = rewriteSpecUrlsToStaging(spec, STAGING);
    expect(out.steps[0]).toBe(
      "Navigate to https://www.apnatutor.live/signup?role=tutor",
    );
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toEqual({
      from: "https://latest.apnatutor.live/signup?role=tutor",
      to: "https://www.apnatutor.live/signup?role=tutor",
    });
  });

  it("does NOT rewrite external origins (OAuth, payments, docs)", () => {
    const spec = {
      steps: [
        "Navigate to https://www.apnatutor.live/login",
        "Click 'Continue with Google' which goes to https://accounts.google.com/o/oauth2/auth",
      ],
    };
    const { spec: out, rewrites } = rewriteSpecUrlsToStaging(spec, STAGING);
    expect(out.steps[1]).toContain("https://accounts.google.com/o/oauth2/auth");
    expect(rewrites).toHaveLength(0);
  });

  it("leaves already-correct origins untouched", () => {
    const spec = { steps: ["Navigate to https://www.apnatutor.live/pricing"] };
    const { spec: out, rewrites } = rewriteSpecUrlsToStaging(spec, STAGING);
    expect(out.steps[0]).toBe("Navigate to https://www.apnatutor.live/pricing");
    expect(rewrites).toHaveLength(0);
  });

  it("keeps trailing sentence punctuation OUTSIDE the rewritten URL (Codex P2)", () => {
    const spec = {
      steps: ["Navigate to https://latest.apnatutor.live/signup."],
    };
    const { spec: out, rewrites } = rewriteSpecUrlsToStaging(spec, STAGING);
    expect(out.steps[0]).toBe("Navigate to https://www.apnatutor.live/signup.");
    expect(rewrites[0].to).toBe("https://www.apnatutor.live/signup");
  });

  it("survives an unparseable staging origin (no-op)", () => {
    const spec = { steps: ["Navigate to https://latest.apnatutor.live/x"] };
    const { spec: out, rewrites } = rewriteSpecUrlsToStaging(spec, "not a url");
    expect(out).toEqual(spec);
    expect(rewrites).toHaveLength(0);
  });
});

describe("parseQaVerdict (S3)", () => {
  it("parses the trailing fenced qa_verdict block", () => {
    const out = `Observed the signup page.\n\n\`\`\`json\n{"qa_verdict":{"test_result":"pass","blocked_kind":null,"reason":"heading present","evidence":"https://www.apnatutor.live/signup rendered 'Create account'"}}\n\`\`\``;
    const v = parseQaVerdict(out);
    expect(v).not.toBeNull();
    expect(v?.test_result).toBe("pass");
    expect(v?.evidence).toContain("Create account");
  });

  it("takes the LAST parseable block when several exist", () => {
    const out = `\`\`\`json\n{"qa_verdict":{"test_result":"fail","reason":"draft"}}\n\`\`\`\nrevised:\n\`\`\`json\n{"qa_verdict":{"test_result":"blocked","blocked_kind":"needs_write","reason":"form submit required"}}\n\`\`\``;
    const v = parseQaVerdict(out);
    expect(v?.test_result).toBe("blocked");
    expect(v?.blocked_kind).toBe("needs_write");
  });

  it("returns null on missing/malformed verdict", () => {
    expect(parseQaVerdict(null)).toBeNull();
    expect(parseQaVerdict("no verdict here")).toBeNull();
    expect(parseQaVerdict("```json\n{\"other\":1}\n```")).toBeNull();
    expect(parseQaVerdict("```json\n{not json\n```")).toBeNull();
  });

  it("rejects an invalid test_result value", () => {
    expect(
      parseQaVerdict('```json\n{"qa_verdict":{"test_result":"maybe"}}\n```'),
    ).toBeNull();
  });
});

describe("buildWeeklyDigest (S4)", () => {
  const run = (
    title: string,
    verdict: QaVerdict,
  ): Parameters<typeof buildWeeklyDigest>[0][number] => ({
    tenant_id: "t1",
    run_id: "r1",
    test_case_id: "tc1",
    test_title: title,
    test_role: "guest",
    nl_spec: { steps: ["go"], expected_outcome: "ok" },
    verdict,
  });

  it("puts FAILs in tier1, blocked in tier3, summary in tier4", () => {
    const d = buildWeeklyDigest([
      run("Signup renders", { test_result: "pass" }),
      run("Login redirects to /dashboard", {
        test_result: "fail",
        reason: "stayed on /login",
        evidence: "URL was /login?error=500",
      }),
      run("Checkout completes", {
        test_result: "blocked",
        blocked_kind: "needs_write",
      }),
    ]);
    expect(d.tier1).toHaveLength(1);
    expect(d.tier1[0].category).toBe("qa-test-fail");
    expect(d.tier1[0].summary).toContain("stayed on /login");
    expect(d.tier3).toHaveLength(1);
    expect(d.tier3[0].summary).toContain("needs_write");
    expect(d.tier4[0].summary).toBe("Ran 3: 1 pass / 1 fail / 1 blocked.");
    expect(d.rendered_markdown).toContain("❌ Login redirects to /dashboard");
    expect(d.rendered_markdown).toContain("✅ Signup renders");
    expect(d.rendered_markdown).toContain("read-only execution policy");
  });

  it("all-pass digest has empty tier1/tier3", () => {
    const d = buildWeeklyDigest([run("A", { test_result: "pass" })]);
    expect(d.tier1).toHaveLength(0);
    expect(d.tier3).toHaveLength(0);
    expect(d.tier4[0].summary).toBe("Ran 1: 1 pass / 0 fail / 0 blocked.");
  });
});
