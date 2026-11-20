
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(__dirname, "..", "run-agent.ts"), "utf-8");

const TAG = "praxis_context_build_failure";

describe("a context-build failure is retryable on a money-path run", () => {
  it("tags the error thrown by buildContext inside the dispatch step", () => {
    const dispatch = SRC.slice(SRC.indexOf('step.run("dispatch"'));
    const build = dispatch.indexOf("buildContext(claim, run_id)");
    expect(build).toBeGreaterThan(-1);
    const around = dispatch.slice(Math.max(0, build - 400), build + 400);
    expect(around).toContain(TAG);
  });

  it("exempts a tagged error from the money-path NonRetriableError wrap", () => {
    const guard = SRC.slice(SRC.indexOf("isMoneyPathSlug(claim.agent_slug)"));
    const head = guard.slice(0, 200);
    expect(head).toMatch(/isMoneyPathSlug\(claim\.agent_slug\)(\s*\|\|\s*isCustomAgentSlug\(claim\.agent_slug\)\))?\s*&&\s*!/);
    expect(SRC).toContain("isContextBuildFailure");
  });

  it("still wraps a genuine money-path DISPATCH failure (guard not defanged)", () => {
    expect(SRC).toContain("NonRetriableError");
    expect(SRC).toMatch(/money-path run not auto-retried/);
  });

  it("a custom agent's dispatch failure is never replayed either (it writes with no approval)", () => {
    const guard = SRC.slice(SRC.indexOf("isMoneyPathSlug(claim.agent_slug)"), SRC.indexOf("money-path run not auto-retried"));
    expect(guard).toMatch(/isCustomAgentSlug\(claim\.agent_slug\)/);
  });

  it("keeps the tag a plain property, so it survives a non-Error throw", () => {
    expect(SRC).toMatch(/ctxErr\s*&&\s*typeof ctxErr === "object"/);
  });
});
