
import { describe, it, expect, afterEach } from "vitest";
import {
  scrubTransientFailurePhrases,
  scrubAgentEgress,
} from "../scrub-agent-egress";

describe("scrubTransientFailurePhrases — rewrites first-person tool-failure narration", () => {
  it("drops the standalone leak parenthetical (the prod incident)", () => {
    const inp =
      "I wasn't able to read the full Terms of Service text directly (GitHub search rate-limited mid-run), so confirm the age gate in the source.";
    const out = scrubTransientFailurePhrases(inp);
    expect(out.hits).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/rate-?limit/i);
    expect(out.text).not.toMatch(/mid-run/i);
    expect(out.text).toMatch(/Terms of Service/);
    expect(out.text).toMatch(/age gate/);
  });

  it("rewrites 'I've hit the search budget limit'", () => {
    const out = scrubTransientFailurePhrases(
      "I've hit the search budget limit. Based on what I found, the answer is 18.",
    );
    expect(out.hits).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/search budget/i);
    expect(out.text).toMatch(/the answer is 18/);
  });

  it("rewrites a bare 'GitHub search rate-limited' mid-sentence", () => {
    const out = scrubTransientFailurePhrases(
      "GitHub search was rate-limited before I could read the host file.",
    );
    expect(out.hits).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/rate-?limit/i);
  });

  it("rewrites a 'search_code HTTP 403' narration", () => {
    const out = scrubTransientFailurePhrases(
      "That lookup failed: search_code HTTP 403 on the connected repo.",
    );
    expect(out.hits).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/HTTP 403/);
  });
});

describe("scrubTransientFailurePhrases — FALSE-POSITIVE corpus (must NOT touch)", () => {
  it("survives the customer's OWN rate-limit (3rd-person, a legit answer)", () => {
    const inp =
      "Your GitHub token is rate-limited (403) — raise the limit in Settings → Developer.";
    const out = scrubTransientFailurePhrases(inp);
    expect(out.hits).toBe(0);
    expect(out.text).toBe(inp);
  });

  it("survives evidence IDs — file paths, symbols, SHAs", () => {
    const inp =
      "The fee logic is in src/search/pricing.ts:42 and SearchBudgetExceededError at line 88 (commit a1b2c3d).";
    const out = scrubTransientFailurePhrases(inp);
    expect(out.hits).toBe(0);
    expect(out.text).toBe(inp);
  });

  it("survives legitimate engineer code-search references", () => {
    const inp =
      "code_refs returned zero hits across the repo (code-index + search_code), so the symbol is unwired.";
    const out = scrubTransientFailurePhrases(inp);
    expect(out.hits).toBe(0);
    expect(out.text).toBe(inp);
  });
});

describe("scrubAgentEgress — EGRESS_TRANSIENT_SCRUB flag gating", () => {
  const KEY = "EGRESS_TRANSIENT_SCRUB";
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  const leak = "I've hit the search budget limit. The answer is 18.";

  it("rewrite mode: rewrites the text + tags the transient_failure family", () => {
    process.env[KEY] = "rewrite";
    const r = scrubAgentEgress(leak, { surface: "slack", agentSlug: "support-lead" });
    expect(r.hits).toBeGreaterThan(0);
    expect(r.families).toContain("transient_failure");
    expect(r.text).not.toMatch(/search budget/i);
    expect(r.text).toMatch(/The answer is 18/);
  });

  it("log mode (shadow): COUNTS the leak but leaves the text UNCHANGED", () => {
    process.env[KEY] = "log";
    const r = scrubAgentEgress(leak, { surface: "slack", agentSlug: "support-lead" });
    expect(r.families).toContain("transient_failure");
    expect(r.hits).toBeGreaterThan(0);
    expect(r.text).toMatch(/search budget limit/);
  });

  it("off mode: no transient scrub at all", () => {
    process.env[KEY] = "off";
    const r = scrubAgentEgress(leak, { surface: "slack", agentSlug: "support-lead" });
    expect(r.families).not.toContain("transient_failure");
    expect(r.text).toMatch(/search budget limit/);
  });

  it("UNSET env → rewrite (the default flipped from 'log' 2026-08-29)", () => {
    delete process.env[KEY];
    const r = scrubAgentEgress(leak, { surface: "slack", agentSlug: "support-lead" });
    expect(r.families).toContain("transient_failure");
    expect(r.text).not.toMatch(/search budget/i);
    expect(r.text).toMatch(/The answer is 18/);
  });

  it("the rewrite is DELIBERATELY not slack-only — persist covers the web chat customer", () => {
    delete process.env[KEY];
    const r = scrubAgentEgress(leak, { surface: "persist", agentSlug: "operator" });
    expect(r.families).toContain("transient_failure");
    expect(r.text).not.toMatch(/search budget/i);
  });
});
