
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const RUN_AGENT_FILE = join(__dirname, "..", "run-agent.ts");

function collectTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectTs(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

describe("F-4 per-tenant concurrency — runAgentFn config", () => {
  const src = readFileSync(RUN_AGENT_FILE, "utf8");

  it("declares a concurrency array on runAgentFn", () => {
    expect(src).toMatch(/concurrency:\s*\[/);
  });

  it("has a per-tenant virtual queue keyed on event.data.tenant_id", () => {
    expect(src).toMatch(/key:\s*["']event\.data\.tenant_id["']/);
  });

  it("has a global ceiling belt (constant-keyed limit)", () => {
    expect(src).toMatch(/key:\s*'"run-agent-global"'/);
  });

  it("per-tenant limit is a positive literal; global ceiling is env-driven (memcg bound)", () => {
    const limits = [
      ...src.matchAll(/limit:\s*([A-Z_]+|opts\.globalLimit|\d+)/g),
    ].map((m) => m[1]);
    expect(limits.length).toBeGreaterThanOrEqual(2);
    expect(limits).toContain("RUN_AGENT_PER_TENANT_CONCURRENCY");
    expect(limits).toContain("opts.globalLimit");
    const perTenant = src.match(/RUN_AGENT_PER_TENANT_CONCURRENCY\s*=\s*(\d+)/);
    expect(perTenant).not.toBeNull();
    expect(Number(perTenant![1])).toBeGreaterThan(0);
    expect(src).toMatch(
      /RUN_AGENT_GLOBAL_CONCURRENCY\s*=\s*resolveRunAgentGlobalConcurrency\(\)/,
    );
    expect(src).not.toMatch(/RUN_AGENT_GLOBAL_CONCURRENCY\s*=\s*50\b/);
  });

  it("GAP 11: global belt is ACCOUNT-scope (shared across both split functions) with an interactive reserve", () => {
    expect(src).toMatch(/scope:\s*"account"[\s\S]{0,120}"run-agent-global"/);
    expect(src).toMatch(/RUN_AGENT_GLOBAL_CONCURRENCY - RUN_AGENT_BACKGROUND_RESERVE/);
  });
});

describe("F-4 cross-cut — every agent.run.requested emitter carries tenant_id", () => {
  const files = collectTs(BACKEND_ROOT);
  const emitters: { file: string; index: number }[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let idx = text.indexOf('name: "agent.run.requested"');
    while (idx !== -1) {
      emitters.push({ file: f, index: idx });
      idx = text.indexOf('name: "agent.run.requested"', idx + 1);
    }
  }

  it("finds the centralized emitters (sanity)", () => {
    expect(emitters.length).toBeGreaterThanOrEqual(3);
    const helper = readFileSync(
      join(BACKEND_ROOT, "src", "services", "agents", "run-lane.ts"),
      "utf8",
    );
    expect(helper).toMatch(/export function buildRunRequestedEvent\(/);
  });

  it("every emitter's data object includes tenant_id", () => {
    const offenders: string[] = [];
    for (const { file, index } of emitters) {
      const text = readFileSync(file, "utf8");
      const window = text.slice(index, index + 400);
      if (!/tenant_id/.test(window)) {
        offenders.push(`${file.replace(BACKEND_ROOT, "")} @ ${index}`);
      }
    }
    expect(offenders, `emitters missing tenant_id: ${offenders.join(", ")}`).toEqual([]);
  });
});
