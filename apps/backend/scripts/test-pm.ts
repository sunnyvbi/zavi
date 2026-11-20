
import "dotenv/config";
import {
  productPmBacklogSchema,
  CODE_DISPATCH_TARGETS,
} from "@/agents/pm/output-schema";
import { productPmInputSchema } from "@/agents/pm/input-contract";
import { computeDedupKey } from "@/agents/pm/post-run";

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

function expectValid<T>(name: string, fn: () => T): void {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, `expected accept, got: ${(e as Error).message}`);
  }
}
function expectInvalid(name: string, fn: () => unknown, expectMsg?: string): void {
  try {
    fn();
    bad(name, "expected schema to reject; it accepted");
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (expectMsg && !msg.includes(expectMsg)) {
      bad(name, `wrong rejection message — expected "${expectMsg}", got: ${msg.slice(0, 200)}`);
    } else {
      ok(name);
    }
  }
}

function validBrief() {
  return {
    status: "actionable" as const,
    summary: {
      bullets: ["3 engineer parse_failed runs on auth quirk [src: run-1]"],
      top_theme: "auth-quirk",
    },
    backlog: [
      {
        item_id: "item-auth-quirk",
        theme: "Auth helper drops session token on expiry",
        theme_normalized: "auth-helper-drops-session-token-on-expiry",
        problem: "3 runs in 14d hit the same null-token branch in auth.ts:47.",
        proposed_fix: "Add null-guard + refresh in auth.ts:47 before the check.",
        target: "backend" as const,
        code_reach: 3,
        code_confidence: 1,
        impact: "high" as const,
        effort: "low" as const,
        rice_score: 27,
        reasoning: "High-frequency known location; easy fix.",
        evidence_sources: [
          { agent_run_id: "11111111-1111-1111-1111-111111111111", summary: "parse_failed engineer" },
        ],
      },
    ],
    dispatched_actions: [
      {
        item_id: "item-auth-quirk",
        target_agent_slug: "engineer" as const,
        task_description:
          "Add null-guard for session token in apps/backend/src/services/auth.ts around line 47, before the existing expiry check.",
        repo_hint: "rravi149/praxis",
        file_hints: ["apps/backend/src/services/auth.ts"],
        child_run_id: "pending",
      },
    ],
    recommended_actions_not_dispatched: [],
    sources_all: [
      {
        tool_name: "praxis_corpus__query_recent_runs",
        query_summary: "14d lookback, status=parse_failed",
        fetched_at: "2026-05-10T12:00:00Z",
      },
    ],
    snapshot_run_id: "run-server-injected",
  };
}

console.log("product_pm_backlog schema");

expectValid("E1 minimal valid brief parses", () => productPmBacklogSchema.parse(validBrief()));

expectInvalid(
  "E2 rejects $-figures",
  () => {
    const b = validBrief();
    b.summary.bullets[0] = "Costing us $200/wk in support [src: run-1]";
    return productPmBacklogSchema.parse(b);
  },
  "dollar figures",
);

expectInvalid(
  "E3 rejects status=actionable + 0 backlog items",
  () => {
    const b = validBrief();
    b.backlog = [];
    b.dispatched_actions = [];
    return productPmBacklogSchema.parse(b);
  },
  "actionable",
);

expectInvalid(
  "E4 rejects status=no_signal + backlog populated",
  () => {
    const b: Record<string, unknown> = validBrief();
    b.status = "no_signal";
    return productPmBacklogSchema.parse(b);
  },
  "no_signal",
);

expectInvalid(
  "E5 rejects dispatched item_id not in backlog",
  () => {
    const b = validBrief();
    b.dispatched_actions[0].item_id = "nonexistent";
    return productPmBacklogSchema.parse(b);
  },
  "no matching backlog entry",
);

expectInvalid(
  "E6 rejects target_agent_slug != engineer",
  () => {
    const b: Record<string, unknown> = validBrief();
    (b.dispatched_actions as Array<Record<string, unknown>>)[0].target_agent_slug = "supply-onboarding";
    return productPmBacklogSchema.parse(b);
  },
);

expectInvalid(
  "E7 rejects dispatched item w/ target='product' (too vague for engineer)",
  () => {
    const b: Record<string, unknown> = validBrief();
    const backlog = b.backlog as Array<Record<string, unknown>>;
    backlog[0].target = "product";
    return productPmBacklogSchema.parse(b);
  },
  "code-shape target",
);

expectInvalid(
  "E8 rejects backlog item with 0 evidence_sources",
  () => {
    const b = validBrief();
    b.backlog[0].evidence_sources = [];
    return productPmBacklogSchema.parse(b);
  },
);

expectValid(
  "E9 accepts status=no_signal + empty backlog",
  () => {
    const b: Record<string, unknown> = validBrief();
    b.status = "no_signal";
    b.backlog = [];
    b.dispatched_actions = [];
    return productPmBacklogSchema.parse(b);
  },
);

expectValid(
  "E10 accepts status=insufficient_data + empty backlog",
  () => {
    const b: Record<string, unknown> = validBrief();
    b.status = "insufficient_data";
    b.backlog = [];
    b.dispatched_actions = [];
    return productPmBacklogSchema.parse(b);
  },
);

console.log("\ninput-contract");

expectValid("I1 accepts empty payload (defaults)", () => productPmInputSchema.parse({}));
expectInvalid("I2 rejects invalid agent_slug_filter", () =>
  productPmInputSchema.parse({ agent_slug_filter: "Has Caps" }),
);
expectInvalid("I3 rejects lookback_days > 90", () =>
  productPmInputSchema.parse({ lookback_days: 100 }),
);
expectInvalid("I4 rejects max_dispatches > 3", () =>
  productPmInputSchema.parse({ max_dispatches: 5 }),
);

console.log("\npost-run helpers");

(() => {
  const k1 = computeDedupKey({
    source: "pm",
    target: "engineer",
    target_kind: "backend",
    repo_hint: "rravi149/praxis",
    file_hints: ["apps/backend/src/services/auth.ts", "apps/backend/src/lib/session.ts"],
  });
  const k2 = computeDedupKey({
    source: "pm",
    target: "engineer",
    target_kind: "backend",
    repo_hint: "rravi149/praxis",
    file_hints: ["apps/backend/src/lib/session.ts", "apps/backend/src/services/auth.ts"],
  });
  if (k1 !== k2) return bad("H1 dedup_key stable across file_hints reorder", `${k1} vs ${k2}`);
  ok("H1 dedup_key stable across file_hints reorder (sorted internally)");
})();

(() => {
  const base = {
    source: "pm",
    target: "engineer",
    target_kind: "agent_prompt",
    repo_hint: "rravi149/praxis",
    file_hints: ["apps/backend/src/agents/pm/agent.md"],
  };
  const k1 = computeDedupKey(base);
  const k2 = computeDedupKey({ ...base });
  if (k1 !== k2) return bad("H2 same PR target → same key regardless of LLM theme wording", `${k1} vs ${k2}`);
  const k3 = computeDedupKey({ ...base, file_hints: ["apps/backend/src/agents/chief-of-staff/agent.md"] });
  if (k1 === k3) return bad("H2 different file_hints must not collide", "keys collided");
  ok("H2 dedup_key keyed on touched files, not LLM theme wording (regression)");
})();

(() => {
  const k = computeDedupKey({
    source: "pm",
    target: "engineer",
    target_kind: "backend",
    repo_hint: "rravi149/praxis",
    file_hints: ["a"],
  });
  if (!/^pm:engineer:[a-f0-9]{32}$/.test(k)) {
    return bad("H3 dedup_key shape", `got: ${k}`);
  }
  ok("H3 dedup_key shape = '<source>:<target>:<32-hex sha256 prefix>'");
})();

(() => {
  if ((CODE_DISPATCH_TARGETS as readonly string[]).includes("product")) {
    return bad("H4 CODE_DISPATCH_TARGETS excludes product", "'product' present");
  }
  ok("H4 CODE_DISPATCH_TARGETS excludes 'product' (engineer-shippable only)");
})();

console.log(`\n${pass} passed · ${fail} failed`);
if (fail > 0) process.exit(1);
