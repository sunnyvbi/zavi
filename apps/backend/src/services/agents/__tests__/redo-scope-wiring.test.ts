
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER = readFileSync(join(__dirname, "../runner.ts"), "utf-8");
const DISPATCHER = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");

describe("layer 2 — the belt in runner.ts emitDecision", () => {
  const GUARD = "if (redoRefusesClass(runCarriesRedo(claim.payload), decision_class)) {";

  it("refuses off the CLAIM row's payload, not off anything the model supplied", () => {
    expect(RUNNER).toContain(GUARD);
  });

  it("fires BEFORE the emit_decision RPC, so nothing is persisted first", () => {
    const guard = RUNNER.indexOf(GUARD);
    const rpc = RUNNER.indexOf('serviceClient().rpc("emit_decision"');
    expect(guard).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rpc);
  });

  it("throws rather than returning, so a refusal cannot read as a success", () => {
    const at = RUNNER.indexOf(GUARD);
    expect(at, "redo belt guard not found").toBeGreaterThan(-1);
    const body = RUNNER.slice(at, RUNNER.indexOf("\n      }", at));
    expect(body).toMatch(/throw new (Error|EmitNoWriteError)\(/);
    expect(body).toMatch(/logDecisionNotTaken\(/);
  });
});

describe("layer 1 — the strip in generic-dispatcher.ts", () => {
  it("wraps the resolved tool list the legacy loop consumes", () => {
    expect(DISPATCHER).toMatch(
      /const resolved: ResolvedTool\[\] = stripProposeToolsOnRedo\(\s*stripMemoryToolsIfOff\(discovery\.tools, ctx\),\s*carriesRedo,\s*chatAnswerTurn,\s*\)/,
    );
  });

  it("derives the flag from the payload once, before either consumer", () => {
    const decl = DISPATCHER.indexOf("const carriesRedo = runCarriesRedo(payload)");
    const legacyLoop = DISPATCHER.indexOf("const resolved: ResolvedTool[] = stripProposeToolsOnRedo(");
    const sdkCtx = DISPATCHER.indexOf("redo: carriesRedo,");
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(legacyLoop);
    expect(decl).toBeLessThan(sdkCtx);
  });

  it("hands the flag to the SDK server too, which resolves its own list", () => {
    expect(DISPATCHER).toMatch(/redo: carriesRedo,/);
  });
});
