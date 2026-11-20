
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DISPATCH_PATH = path.resolve(
  __dirname,
  "../../../../../../workers/functions/dispatch-decision.ts",
);

const SOURCE = readFileSync(DISPATCH_PATH, "utf8");

const HANDLER_KEY_RE = /^ {2}"([a-z_]+\.[a-z_]+)":/gm;

function handlerKeys(): string[] {
  const keys: string[] = [];
  for (const m of SOURCE.matchAll(HANDLER_KEY_RE)) keys.push(m[1]);
  return keys;
}

function handlerBody(slug: string): string {
  const keys = handlerKeys();
  const idx = keys.indexOf(slug);
  expect(idx, `handler ${slug} must exist in dispatch-decision.ts`).toBeGreaterThanOrEqual(0);
  const startMatch = SOURCE.indexOf(`  "${slug}":`);
  const next = keys[idx + 1];
  const endMatch = next ? SOURCE.indexOf(`  "${next}":`) : SOURCE.length;
  return SOURCE.slice(startMatch, endMatch === -1 ? SOURCE.length : endMatch);
}

const META_SPEND_HANDLERS = [
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget",
  "meta_ads.update_campaign_budget_review",
  "meta_ads.set_status",
  "meta_ads.set_status_review",
  "meta_ads.create_ad_set",
  "meta_ads.create_campaign",
  "meta_ads.launch_campaign",
];

const GATE_ONLY_ALLOWLIST: Record<string, string> = {
  "meta_ads.update_ad_set_budget_review":
    "delegates to meta_ads.update_ad_set_budget (inherits its cap recheck).",
  "meta_ads.update_campaign_budget_review":
    "delegates to meta_ads.update_campaign_budget (inherits its cap recheck).",
  "meta_ads.set_status_review":
    "delegates to meta_ads.set_status (inherits its ACTIVE-resume cap recheck / PAUSE-safe behaviour).",
};

function callsCapEvaluator(slug: string): boolean {
  return /evaluateBudgetCap\s*\(|metaBudgetCapRefusal\s*\(/.test(handlerBody(slug));
}

function isReviewAliasDelegation(slug: string): boolean {
  return new RegExp(`"${slug.replace(/\./g, "\\.")}":\\s*async \\(d\\) => HANDLERS\\[`).test(SOURCE);
}

describe("write-contract conformance — every Meta spend write caps or is allowlisted", () => {
  it("each Meta-Ads spend handler routes through evaluateBudgetCap OR is gate-only-allowlisted", () => {
    for (const slug of META_SPEND_HANDLERS) {
      const caps = callsCapEvaluator(slug);
      const allowlisted = slug in GATE_ONLY_ALLOWLIST;
      expect(
        caps || allowlisted,
        `money-write handler "${slug}" must either call evaluateBudgetCap or be explicitly gate-only-allowlisted with a documented reason`,
      ).toBe(true);
    }
  });

  it("budget + create handlers DO cap-recheck at dispatch (the gold-standard path)", () => {
    expect(callsCapEvaluator("meta_ads.update_ad_set_budget")).toBe(true);
    expect(callsCapEvaluator("meta_ads.update_campaign_budget")).toBe(true);
    expect(callsCapEvaluator("meta_ads.create_ad_set")).toBe(true);
  });

  it("the *_review aliases delegate to their auto sibling (inherit its cap behaviour)", () => {
    expect(isReviewAliasDelegation("meta_ads.update_ad_set_budget_review")).toBe(true);
    expect(isReviewAliasDelegation("meta_ads.set_status_review")).toBe(true);
  });

  it("every gate-only-allowlist entry carries a documented reason", () => {
    for (const [slug, reason] of Object.entries(GATE_ONLY_ALLOWLIST)) {
      expect(reason.length, `allowlist entry ${slug} needs a non-trivial documented reason`).toBeGreaterThan(20);
    }
  });
});

describe("CAP-SYMMETRY (Gap-3 — ACTIVE/resume cap recheck, FIXED 2026-05-22)", () => {
  it("meta_ads.set_status cap-rechecks the ACTIVE/resume case at dispatch", () => {
    expect(callsCapEvaluator("meta_ads.set_status")).toBe(true);
  });
});
