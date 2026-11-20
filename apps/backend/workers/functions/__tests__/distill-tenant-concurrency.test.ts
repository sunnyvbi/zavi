
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS_DIR = join(__dirname, "..");
const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const HELPER_FILE = join(FUNCTIONS_DIR, "distill-concurrency.ts");

const DISTILL_FNS = [
  { file: "distill-event.ts", globalKey: "distill-slack-event-global" },
  { file: "distill-agent-run.ts", globalKey: "distill-agent-run-global" },
  { file: "distill-chat-turn.ts", globalKey: "distill-chat-turn-global" },
];

const DISTILL_EVENTS = [
  "webhook.slack.ingested",
  "agent.run.distillable",
  "chat.turn_complete",
];

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

describe("distill per-tenant concurrency — shared helper", () => {
  const src = readFileSync(HELPER_FILE, "utf8");

  it("keys the per-tenant virtual queue on event.data.tenant_id", () => {
    expect(src).toMatch(/key:\s*["']event\.data\.tenant_id["']/);
  });

  it("defines PER_TENANT and GLOBAL as positive ints with PER_TENANT < GLOBAL", () => {
    const perTenant = src.match(/DISTILL_PER_TENANT_CONCURRENCY\s*=\s*(\d+)/);
    const global = src.match(/DISTILL_GLOBAL_CONCURRENCY\s*=\s*(\d+)/);
    expect(perTenant).not.toBeNull();
    expect(global).not.toBeNull();
    expect(Number(perTenant![1])).toBeGreaterThan(0);
    expect(Number(global![1])).toBeGreaterThan(0);
    expect(Number(perTenant![1])).toBeLessThan(Number(global![1]));
  });
});

describe("distill per-tenant concurrency — function wiring", () => {
  for (const { file, globalKey } of DISTILL_FNS) {
    const src = readFileSync(join(FUNCTIONS_DIR, file), "utf8");

    it(`${file} builds concurrency via distillConcurrency()`, () => {
      expect(src).toMatch(/concurrency:\s*distillConcurrency\(/);
      expect(src).not.toMatch(/concurrency:\s*\d+/);
    });

    it(`${file} passes its own global pool key`, () => {
      expect(src).toContain(`distillConcurrency("${globalKey}")`);
    });
  }
});

describe("distill per-tenant concurrency — every emitter carries tenant_id", () => {
  const files = collectTs(BACKEND_ROOT);
  const emitters: { file: string; index: number; event: string }[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const ev of DISTILL_EVENTS) {
      const marker = `name: "${ev}"`;
      let idx = text.indexOf(marker);
      while (idx !== -1) {
        emitters.push({ file: f, index: idx, event: ev });
        idx = text.indexOf(marker, idx + 1);
      }
    }
  }

  it("finds at least the known literal emit sites (sanity)", () => {
    expect(emitters.length).toBeGreaterThanOrEqual(4);
  });

  it("every literal emit site includes tenant_id in its data block", () => {
    const offenders: string[] = [];
    for (const { file, index, event } of emitters) {
      const text = readFileSync(file, "utf8");
      const window = text.slice(index, index + 400);
      if (!/tenant_id/.test(window)) {
        offenders.push(`${file.replace(BACKEND_ROOT, "")} (${event}) @ ${index}`);
      }
    }
    expect(offenders, `emitters missing tenant_id: ${offenders.join(", ")}`).toEqual([]);
  });
});
