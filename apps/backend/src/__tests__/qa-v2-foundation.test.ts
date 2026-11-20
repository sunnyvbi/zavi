
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "..", "..");

describe("qa v2 foundation — F2/F3 deletion regression", () => {
  it("F2 block is removed from dispatch-decision.ts", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "workers", "functions", "dispatch-decision.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/F2 — engineer ↔ qa gate/);
    expect(src).not.toMatch(/target_agent_slug:\s*["']qa["']/);
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + 5).join("\n");
      if (
        /engineer\.ship-pr/.test(window) &&
        /target_agent_slug:\s*["']qa["']/.test(window)
      ) {
        throw new Error(`F2 block leak at line ${i + 1}: ${window.slice(0, 200)}`);
      }
    }
  });

  it("F3 files are deleted", () => {
    expect(existsSync(join(BACKEND_ROOT, "src", "agents", "qa", "dispatcher.ts"))).toBe(false);
    expect(
      existsSync(
        join(BACKEND_ROOT, "src", "agents", "qa", "__tests__", "dispatcher-wiring.test.ts"),
      ),
    ).toBe(false);
  });

  it("the old f2-wiring.test.ts (which asserted F2 hook EXISTS) is deleted", () => {
    expect(
      existsSync(join(BACKEND_ROOT, "workers", "functions", "f2-wiring.test.ts")),
    ).toBe(false);
  });

  it("agents/index.ts does not import the deleted qa modules", () => {
    const src = readFileSync(join(BACKEND_ROOT, "src", "agents", "index.ts"), "utf-8");
    expect(src).not.toMatch(/from\s+["']\.\/qa\/dispatcher["']/);
    expect(src).not.toMatch(/qaEngineerPostProcess/);
    expect(src).not.toMatch(/qaEngineerDispatcher/);
  });

  it("agents/index.ts does not register qa as a bespoke dispatcher or post-processor", () => {
    const src = readFileSync(join(BACKEND_ROOT, "src", "agents", "index.ts"), "utf-8");
    expect(src).not.toMatch(/"qa":\s*qaEngineerDispatcher/);
    expect(src).not.toMatch(/"qa":\s*qaEngineerPostProcess/);
  });
});
