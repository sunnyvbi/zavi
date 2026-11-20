
import "dotenv/config";
import { prProposalSchema } from "@/agents/engineer/output-schema";
import { ctoShipPrPayloadSchema } from "@/agents/engineer/input-contract";

let pass = 0;
let fail = 0;

function ok(name: string): void {
  pass += 1;
  console.log(`  ✓ ${name}`);
}

function bad(name: string, why: string): void {
  fail += 1;
  console.error(`  ✗ ${name}\n      ${why}`);
}

function expectFail(name: string, fn: () => unknown, expectMsg?: string): void {
  try {
    fn();
    bad(name, "expected schema to reject; it accepted");
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (expectMsg && !msg.includes(expectMsg)) {
      bad(name, `error msg did not contain "${expectMsg}":\n      ${msg}`);
    } else {
      ok(name);
    }
  }
}

function expectOk(name: string, fn: () => unknown): void {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, (e as Error).message ?? "unknown error");
  }
}

console.log("[test:cto-schemas] running");

expectFail(
  "U1 pr_proposal rejects diff with 51 added/deleted lines",
  () => {
    const big = Array.from({ length: 51 }).map((_, i) => `+line ${i}`).join("\n");
    prProposalSchema.parse({
      repo: "rravi149/praxis",
      base_branch: "main",
      head_branch: "engineer/abc",
      title: "test",
      body: "",
      files: [{ path: "x.ts", action: "modify", content: "x", diff: big }],
      test_results: { passed: 0, failed: 0, output_tail: "" },
      risk_class: "low",
    });
  },
  "exceeds line cap",
);

expectFail(
  "U2 pr_proposal rejects 6-file diff",
  () => {
    prProposalSchema.parse({
      repo: "rravi149/praxis",
      base_branch: "main",
      head_branch: "engineer/abc",
      title: "test",
      body: "",
      files: Array.from({ length: 6 }).map((_, i) => ({
        path: `x${i}.ts`,
        action: "modify" as const,
        content: "a",
        diff: "+a\n",
      })),
      test_results: { passed: 0, failed: 0, output_tail: "" },
      risk_class: "low",
    });
  },
);

expectFail(
  "U2b pr_proposal rejects single line > 16KB",
  () => {
    const giant = `+${"x".repeat(17 * 1024)}`;
    prProposalSchema.parse({
      repo: "rravi149/praxis",
      base_branch: "main",
      head_branch: "engineer/abc",
      title: "test",
      body: "",
      files: [{ path: "x.ts", action: "modify", content: "x", diff: giant }],
      test_results: { passed: 0, failed: 0, output_tail: "" },
      risk_class: "low",
    });
  },
  "exceeds byte cap",
);

expectFail("U3a CtoShipPrPayload rejects missing task_description", () => {
  ctoShipPrPayloadSchema.parse({
    context_summary: "x",
    source_agent: "manual",
  });
});

expectOk("U3b CtoShipPrPayload accepts minimal body", () => {
  ctoShipPrPayloadSchema.parse({
    task_description: "do the thing",
  });
});

expectFail("U3c CtoShipPrPayload rejects > 5 file_hints", () => {
  ctoShipPrPayloadSchema.parse({
    task_description: "do the thing",
    file_hints: ["a", "b", "c", "d", "e", "f"],
  });
});

expectOk("U4 pr_proposal accepts normal 1-file modify with content + diff", () => {
  prProposalSchema.parse({
    repo: "rravi149/praxis",
    base_branch: "main",
    head_branch: "engineer/run-abc",
    title: "fix lint",
    body: "fixes lint error in page.tsx",
    files: [
      {
        path: "apps/web/page.tsx",
        action: "modify",
        content: "new\nunchanged\n",
        diff:
          "--- a/apps/web/page.tsx\n+++ b/apps/web/page.tsx\n@@ -1,3 +1,3 @@\n-old\n+new\n unchanged\n",
      },
    ],
    test_results: { passed: 1, failed: 0, output_tail: "" },
    risk_class: "trivial",
  });
});

expectFail("U4b pr_proposal rejects modify without content (BUG-CTO-2 regression guard)", () => {
  prProposalSchema.parse({
    repo: "rravi149/praxis",
    base_branch: "main",
    head_branch: "engineer/run-abc",
    title: "fix lint",
    body: "",
    files: [
      {
        path: "apps/web/page.tsx",
        action: "modify",
        diff: "--- a/apps/web/page.tsx\n+++ b/apps/web/page.tsx\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      },
    ],
    test_results: { passed: 0, failed: 0, output_tail: "" },
    risk_class: "trivial",
  });
});

expectOk("U4c pr_proposal accepts delete without content", () => {
  prProposalSchema.parse({
    repo: "rravi149/praxis",
    base_branch: "main",
    head_branch: "engineer/run-del",
    title: "remove unused file",
    body: "",
    files: [
      {
        path: "apps/web/old.ts",
        action: "delete",
      },
    ],
    test_results: { passed: 0, failed: 0, output_tail: "" },
    risk_class: "low",
  });
});

expectFail("U5 pr_proposal rejects head_branch missing engineer/ prefix", () => {
  prProposalSchema.parse({
    repo: "rravi149/praxis",
    base_branch: "main",
    head_branch: "feature/abc",
    title: "test",
    body: "",
    files: [{ path: "x.ts", action: "modify", content: "a", diff: "+a\n" }],
    test_results: { passed: 0, failed: 0, output_tail: "" },
    risk_class: "low",
  });
});

import { extractForTest } from "./test-engineer-schemas-helpers";
const post = extractForTest(
  "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n keep\n",
);
if (post.trim() === "new\nkeep") {
  ok("U6 extractPostImageFromUnifiedDiff strips '-' + headers");
} else {
  bad("U6 extractPostImageFromUnifiedDiff", `got ${JSON.stringify(post)}`);
}

console.log(`\n[test:cto-schemas] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
