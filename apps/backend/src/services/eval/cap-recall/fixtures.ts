import {
  GIT_DIFF_OVERALL_CAP,
  RUN_BASH_OUTPUT_CAP,
  RUN_TESTS_OUTPUT_CAP,
} from "../../sandbox/tool-registry";
import type { CapProfile } from "./scorer";

export type CapRecallFixture = {
  name: string;
  about: string;
  raw: string;
  capBytes: number;
  capProfile: CapProfile;
  nonZeroExit: boolean;
};

function buriedTscFixture(): string {
  const lines: string[] = [];
  lines.push("> tsc --noEmit -p tsconfig.json");
  for (let i = 1; i <= 200; i++) {
    lines.push(`Checking project reference ${i} of 400 — resolving module graph, no diagnostics emitted yet`);
  }
  lines.push(
    "src/services/payments/refund.ts(142,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  );
  for (let i = 202; i <= 400; i++) {
    lines.push(`Checking project reference ${i} of 400 — resolving module graph, no diagnostics emitted yet`);
  }
  lines.push("Found 1 error in src/services/payments/refund.ts:142");
  return lines.join("\n");
}

function midLogAssertionFixture(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 220; i++) {
    lines.push(` ✓ src/cart/discount.test.ts > applies tier ${i} discount  ${2 + (i % 4)}ms`);
  }
  lines.push(" FAIL  src/cart/discount.test.ts > applies bulk discount over threshold");
  lines.push("   AssertionError: expected 90 to be 80");
  lines.push("   Expected: 80");
  lines.push("   Received: 90");
  lines.push("    ❯ src/cart/discount.test.ts:318:24");
  for (let i = 1; i <= 220; i++) {
    lines.push(` ✓ src/cart/tax.test.ts > applies state tax ${i}  ${2 + (i % 4)}ms`);
  }
  lines.push(" Test Files  1 failed | 2 passed (3)");
  lines.push("      Tests  1 failed | 440 passed (441)");
  return lines.join("\n");
}

function midLogDiffAssertionFixture(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 220; i++) {
    lines.push(` ✓ src/cart/discount.test.ts > applies tier ${i} discount  ${2 + (i % 4)}ms`);
  }
  lines.push(" FAIL  src/cart/discount.test.ts > applies bulk discount over threshold");
  lines.push("   AssertionError: expected 90 to equal 80");
  lines.push("");
  lines.push("   - Expected");
  lines.push("   + Received");
  lines.push("");
  lines.push("   - 80");
  lines.push("   + 90");
  lines.push("");
  lines.push("    ❯ src/cart/discount.test.ts:318:24");
  for (let i = 1; i <= 220; i++) {
    lines.push(` ✓ src/cart/tax.test.ts > applies state tax ${i}  ${2 + (i % 4)}ms`);
  }
  lines.push(" Test Files  1 failed | 2 passed (3)");
  lines.push("      Tests  1 failed | 440 passed (441)");
  return lines.join("\n");
}

function eslintStylishFixture(): string {
  const lines: string[] = [];
  lines.push("/repo/apps/backend/src/services/payments/refund.ts");
  lines.push("  12:3   error    'amount' is assigned a value but never used        @typescript-eslint/no-unused-vars");
  for (let i = 1; i <= 400; i++) {
    lines.push(`  ${20 + i}:5   warning  Unexpected console statement                        no-console`);
  }
  lines.push("/repo/apps/backend/src/services/payments/payout.ts");
  lines.push("  4:10   error    Missing return type on function                     @typescript-eslint/explicit-function-return-type");
  lines.push("");
  lines.push("✖ 403 problems (2 errors, 401 warnings)");
  return lines.join("\n");
}

function giantDiffFixture(): string {
  const lines: string[] = [];
  for (let f = 1; f <= 1200; f++) {
    const path = `apps/web/src/components/generated/Widget${f}.tsx`;
    lines.push(`diff --git a/${path} b/${path}`);
    lines.push("index 0000000..1111111 100644");
    lines.push(`--- a/${path}`);
    lines.push(`+++ b/${path}`);
    lines.push("@@ -1,4 +1,6 @@");
    lines.push(`-export const Widget${f} = () => null;`);
    lines.push(`+export const Widget${f} = () => {`);
    lines.push(`+  return <div className="widget-${f}">generated</div>;`);
    lines.push("+};");
  }
  return lines.join("\n");
}

function giantSingleLineFixture(): string {
  const head =
    "src/services/payments/refund.ts(88,15): error TS2322: Type 'Promise<number>' is not assignable to type 'number'. ";
  const blob = "x".repeat(60 * 1024);
  return head + blob;
}

function cleanPassFixture(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 300; i++) {
    lines.push(` ✓ src/util/format.test.ts > formats value ${i} correctly  ${1 + (i % 3)}ms`);
  }
  lines.push(" Test Files  1 passed (1)");
  lines.push("      Tests  300 passed (300)");
  return lines.join("\n");
}

export const CAP_RECALL_FIXTURES: CapRecallFixture[] = [
  {
    name: "buried-tsc",
    about: "single tsc error buried ~halfway down a 400-line check log",
    raw: buriedTscFixture(),
    capBytes: RUN_BASH_OUTPUT_CAP,
    capProfile: "engineer",
    nonZeroExit: true,
  },
  {
    name: "mid-log-assertion",
    about: "vitest assertion failure in the middle of a long passing run",
    raw: midLogAssertionFixture(),
    capBytes: RUN_TESTS_OUTPUT_CAP,
    capProfile: "engineer",
    nonZeroExit: true,
  },
  {
    name: "mid-log-diff-assertion",
    about: "vitest diff-style (- Expected / + Received) assertion in a long run",
    raw: midLogDiffAssertionFixture(),
    capBytes: RUN_TESTS_OUTPUT_CAP,
    capProfile: "engineer",
    nonZeroExit: true,
  },
  {
    name: "eslint-stylish",
    about: "eslint stylish report padded past the cap with warnings",
    raw: eslintStylishFixture(),
    capBytes: RUN_BASH_OUTPUT_CAP,
    capProfile: "engineer",
    nonZeroExit: true,
  },
  {
    name: "giant-diff",
    about: "multi-thousand-file git diff (no diagnostic markers → vacuous 1.0)",
    raw: giantDiffFixture(),
    capBytes: GIT_DIFF_OVERALL_CAP,
    capProfile: "engineer",
    nonZeroExit: false,
  },
  {
    name: "giant-single-line",
    about: "60KB single-line blob with a tsc error marker near the front",
    raw: giantSingleLineFixture(),
    capBytes: RUN_BASH_OUTPUT_CAP,
    capProfile: "engineer",
    nonZeroExit: true,
  },
  {
    name: "clean-pass",
    about: "fully-passing run, zero markers (must not fabricate signals)",
    raw: cleanPassFixture(),
    capBytes: RUN_TESTS_OUTPUT_CAP,
    capProfile: "engineer",
    nonZeroExit: false,
  },
];
