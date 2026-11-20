import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const factorySrc = readFileSync(
  join(__dirname, "../lib/side-effect-dispatcher.ts"),
  "utf-8",
);
const indexSrc = readFileSync(join(__dirname, "../index.ts"), "utf-8");

describe("createSideEffectDispatcher — keystone wire", () => {
  it("calls ctx.emitDecision with (decisionClass, body)", () => {
    expect(factorySrc).toMatch(
      /await ctx\.emitDecision\(opts\.decisionClass,\s*body\)/,
    );
  });

  it("emits per-body in a loop, so a fanOut run yields N decisions", () => {
    expect(factorySrc).toMatch(
      /let bodies = opts\.fanOut \? opts\.fanOut\(envelope\) : \[envelope\]/,
    );
  });

  it("stamps a redo's replacement into the ORIGINAL run's slot", () => {
    expect(factorySrc).toMatch(/origin_run_id: redo\.origin_run_id/);
    expect(factorySrc).toMatch(/redo_of_decision_id: redo\.redo_of_decision_id/);
  });

  it("archives the superseded action only AFTER the replacement exists", () => {
    expect(factorySrc).toMatch(
      /if \(redo\?\.redo_of_decision_id && emitted\.length > 0\)/,
    );
    expect(factorySrc).toMatch(/"archive_decision"/);
  });

  it("throws when EVERY emit failed — a run that produced nothing is not a success", () => {
    expect(factorySrc).toMatch(/if \(emitted\.length === 0\)/);
    expect(factorySrc).toMatch(/all \$\{bodies\.length\} emit\(s\) failed/);
  });

  it("only emits when parse_ok and parsed is non-null (skips parse_failed runs)", () => {
    expect(factorySrc).toMatch(/if \(!result\.parse_ok \|\| result\.parsed == null\)/);
    expect(factorySrc).toMatch(/return result;/);
  });

  it("supports optional shouldEmit guard for per-agent emission rules", () => {
    expect(factorySrc).toMatch(/if \(opts\.shouldEmit && !opts\.shouldEmit\(envelope, ctx, payload\)\)/);
  });

  it("logs loud (warn) on emit_decision failure — never silent", () => {
    expect(factorySrc).toMatch(/emit_decision failed/);
    expect(factorySrc).toMatch(/console\.warn/);
  });

  it("backfillImprovementAttempt updates only when decision_id is null (idempotent)", () => {
    expect(factorySrc).toMatch(/improvement_attempt/);
    expect(factorySrc).toMatch(/\.update\(\{ decision_id: decisionId \}\)/);
    expect(factorySrc).toMatch(/\.is\("decision_id", null\)/);
  });

  it("scopes improvement_attempt update by tenant_id (cross-tenant defense)", () => {
    expect(factorySrc).toMatch(/\.eq\("tenant_id", ctx\.tenant_id\)/);
  });
});

describe("agents/index.ts — side-effect agents wired through factory", () => {
  it("imports the factory", () => {
    expect(indexSrc).toMatch(
      /import \{ createSideEffectDispatcher \} from "\.\/lib\/side-effect-dispatcher"/,
    );
  });

  const expected = [
    { slug: "engineer", decisionClass: "engineer.ship-pr" },
    { slug: "dispute-response", decisionClass: "dispute-response.submit-evidence" },
  ];

  for (const { slug, decisionClass } of expected) {
    it(`registers ${slug} → ${decisionClass}`, () => {
      const re = new RegExp(
        `"${slug}":\\s*createSideEffectDispatcher\\(\\{[\\s\\S]*?decisionClass:\\s*"${decisionClass.replace(/[.]/g, "\\.")}"`,
      );
      expect(indexSrc).toMatch(re);
    });
  }

  it("engineer specifically opts into improvement_attempt back-fill (closes A2A loop)", () => {
    expect(indexSrc).toMatch(
      /"engineer":\s*createSideEffectDispatcher\(\{[\s\S]*?backfillImprovementAttempt:\s*true/,
    );
  });
});
