import { describe, it, expect } from "vitest";

import {
  extractTestReceipt,
  verifyFromTraces,
} from "@/agents/engineer/engineer-verify-receipt";
import { resolveOpenPrVerify } from "../dispatch-decision";
import {
  buildOpenPrNotice,
  type OpenPrNoticeResult,
} from "../dispatch-notice";

function realRunTestsContent(o: {
  stdout?: string;
  stderr?: string;
  exit_code: number;
  ms?: number;
}): string {
  return JSON.stringify({
    stdout: o.stdout ?? "",
    stderr: o.stderr ?? "",
    exit_code: o.exit_code,
    ms: o.ms ?? 1234,
  });
}

function runChain(
  toolResults: Array<{ name: string; content: string; is_error?: boolean }>,
): string {
  const traces = toolResults.map((t) => ({
    name: t.name,
    test_receipt: extractTestReceipt(t.name, t.content, t.is_error === true),
  }));
  const verify = verifyFromTraces(traces);
  const decisionBody = { title: "Fix payout null deref", verify };
  const resolved = resolveOpenPrVerify(decisionBody);
  const results: OpenPrNoticeResult[] = [
    { base: "main", ok: true, pr_url: "https://github.com/rravi149/upcar/pull/1234", pr_number: 1234 },
  ];
  return buildOpenPrNotice(results, {
    repo: "rravi149/upcar",
    title: "Fix payout null deref",
    head_branch: "engineer/fix-payout",
    verify: resolved,
  });
}

describe("engineer verify → notice wiring (real functions, raw run_tests content)", () => {
  it("exit 0 → real chain renders '✅ tests passed' + neutral PR line, no false '✅ Opened'", () => {
    const notice = runChain([
      { name: "sandbox__run_tests", content: realRunTestsContent({ stdout: "42 passing", exit_code: 0 }) },
    ]);
    expect(notice).toContain("📬 Opened");
    expect(notice).toContain("✅ tests passed");
    expect(notice).not.toContain("✅ Opened");
    expect(notice).toContain("github.com/rravi149/upcar/pull/1234");
  });

  it("CUSTOMER-DANGEROUS: exit 1 (real test failure) → NEVER a ✅; PR still ships", () => {
    const notice = runChain([
      {
        name: "run_tests",
        content: realRunTestsContent({ stdout: "1 failing\n  expected 2 to equal 3", exit_code: 1 }),
      },
    ]);
    expect(notice).toContain("📬 Opened");
    expect(notice).toContain("Tests failed. See the PR.");
    expect(notice).not.toContain("⚠");
    expect(notice).not.toContain("✅");
  });

  it("CUSTOMER-DANGEROUS: stdout SAYS 'all tests passed' but exit 1 → still no ✅ (text never trusted)", () => {
    const notice = runChain([
      {
        name: "run_tests",
        content: realRunTestsContent({ stdout: "All tests passed! 🎉 100 passing", exit_code: 1 }),
      },
    ]);
    expect(notice).not.toContain("✅");
    expect(notice).toContain("Tests failed. See the PR.");
    expect(notice).not.toContain("⚠");
  });

  it("anchored sandbox setup failure (mongodb-memory-server) → plain couldn't-run line + check your CI, no ✅, no ⚠", () => {
    const notice = runChain([
      {
        name: "sandbox__run_tests",
        content: realRunTestsContent({
          stderr: "MongoMemoryServer: Instance failed to start; mongodb-memory-server could not download binary",
          exit_code: 1,
        }),
      },
    ]);
    expect(notice).toContain("Tests couldn't run here");
    expect(notice).toContain("Check them in your CI");
    expect(notice).not.toContain("⚠");
    expect(notice).not.toContain("✅");
  });

  it("no run_tests call this run → 🟡 tests not run (fail-safe honest), no ✅", () => {
    const notice = runChain([
      { name: "run_bash", content: JSON.stringify({ stdout: "ls", exit_code: 0 }) },
      { name: "git_diff", content: "diff --git a b" },
    ]);
    expect(notice).toContain("🟡 tests not run");
    expect(notice).not.toContain("✅");
  });

  it("FAIL-SAFE: a wiring break (verify absent from the body) degrades to a neutral PR line — NEVER a false ✅", () => {
    const resolved = resolveOpenPrVerify({ title: "x"  });
    expect(resolved).toBeUndefined();
    const notice = buildOpenPrNotice(
      [{ base: "main", ok: true, pr_url: "https://github.com/o/r/pull/9", pr_number: 9 }],
      { repo: "o/r", title: "x", head_branch: "b", verify: resolved },
    );
    expect(notice).toContain("📬 Opened");
    expect(notice).not.toContain("✅");
    expect(notice).not.toContain("tests passed");
  });

  it("aggregation: a failing run_tests anywhere in the run dominates a passing one → no ✅", () => {
    const notice = runChain([
      { name: "run_tests", content: realRunTestsContent({ exit_code: 0 }) },
      { name: "run_tests", content: realRunTestsContent({ stdout: "1 failing", exit_code: 1 }) },
    ]);
    expect(notice).toContain("Tests failed. See the PR.");
    expect(notice).not.toContain("⚠");
    expect(notice).not.toContain("✅");
  });
});
