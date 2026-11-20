import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelUsedFor, routingForPersist } from "../staff-model-model-used";

describe("modelUsedFor", () => {
  it("staff run → the OpenRouter id", () => {
    expect(modelUsedFor({ staff_model: { key: "kimi" } }, "claude-sonnet-5-5")).toBe("moonshotai/kimi-k3");
  });
  it("Claude variant → the Claude model id", () => {
    expect(modelUsedFor({ staff_model: { key: "opus-high" } }, "claude-sonnet-5-5")).toBe("claude-opus-5-5");
  });
  it("normal run / unknown key / no payload → declared model", () => {
    expect(modelUsedFor({}, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(modelUsedFor({ staff_model: { key: "llama" } }, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(modelUsedFor(null, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });
});

describe("routingForPersist", () => {
  const routing = { model: "claude-haiku-4-5", effective: true };
  it("drops the router's pick on a staff run (it did not run)", () => {
    expect(routingForPersist({ staff_model: { key: "qwen" } }, routing)).toBeNull();
  });
  it("keeps it on every other run", () => {
    expect(routingForPersist({}, routing)).toBe(routing);
    expect(routingForPersist({}, null)).toBeNull();
  });
});

describe("run-agent wiring", () => {
  const src = readFileSync(join(__dirname, "../run-agent.ts"), "utf-8");
  it("success path: ctx.model (fed to finalizeRun) is the staff model", () => {
    expect(src).toMatch(/const ctx = \{ model: modelUsedFor\(claim\.payload, agentDef\.metadata_praxis\.model\) \};/);
    expect(src).toMatch(/model: ctx\.model,/);
  });
  it("failure path: persist-failure records the staff model", () => {
    const at = src.indexOf('step.run("persist-failure"');
    expect(src.slice(at, at + 1200)).toMatch(/modelUsedFor\(claim\.payload, MODELS\.anthropic\.sonnet\)/);
  });
  it("the router decision is attached only through routingForPersist", () => {
    expect(src).toMatch(/const persistedRouting = routingForPersist\(claim\.payload, routing\);/);
    expect(src).toMatch(/if \(persistedRouting\) \{\s*\n\s*\(rawDispatchResult as DispatcherResult\)\.routing = persistedRouting;/);
  });
});
