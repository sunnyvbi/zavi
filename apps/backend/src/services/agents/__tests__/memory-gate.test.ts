import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn() }));
vi.mock("../runner", () => ({ readRunStatusAndTenant: vi.fn() }));

import {
  checkMemoryGate,
  runMemoryGate,
  MEMORY_GATE_MAX_ITERATIONS,
  type MemoryGateCheck,
  type MemoryGateReaders,
} from "../memory-gate";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type Fake = { run: unknown; memory: unknown; created: unknown };
const boom = new Error("boom");

async function check(f: Fake) {
  const seen: Record<string, unknown> = {};
  const val = (v: unknown) => (v === boom ? Promise.reject(boom) : Promise.resolve(v));
  const readers: MemoryGateReaders = {
    readRun: async (id) => {
      seen.run = id;
      return val(f.run) as never;
    },
    readMemoryStatus: async (tid) => {
      seen.memory = tid;
      return val(f.memory) as never;
    },
    readTenantCreatedAt: async (tid) => {
      seen.tenant = tid;
      return val(f.created) as never;
    },
  };
  const r = await checkMemoryGate("run-1", { readers, now: () => NOW });
  return { r, seen };
}

describe("checkMemoryGate", () => {
  const holding: Fake = {
    run: { status: "queued", tenant_id: "t-1" },
    memory: "pending",
    created: minsAgo(2),
  };

  it("holds a queued run whose young tenant's memory is pending, reading the tenant from the run row", async () => {
    const { r, seen } = await check(holding);
    expect(r).toEqual({ hold: true, reason: "hold", at: NOW });
    expect(seen).toEqual({ run: "run-1", memory: "t-1", tenant: "t-1" });
  });

  it.each([
    ["memory ready", { ...holding, memory: "ready" }, "memory_ready"],
    ["memory failed", { ...holding, memory: "failed" }, "memory_failed"],
    ["no memory row (existing tenant)", { ...holding, memory: null }, "no_memory_row"],
    ["tenant older than 15 min", { ...holding, created: minsAgo(16) }, "tenant_old"],
    ["tenant row missing", { ...holding, created: null }, "tenant_old"],
    ["run already running", { ...holding, run: { status: "running", tenant_id: "t-1" } }, "run_not_queued"],
    ["run cancelled", { ...holding, run: { status: "cancelled", tenant_id: "t-1" } }, "run_not_queued"],
    ["run missing", { ...holding, run: null }, "run_not_queued"],
    ["run read error", { ...holding, run: boom }, "read_error"],
    ["memory read error", { ...holding, memory: boom }, "read_error"],
    ["tenant read error", { ...holding, created: boom }, "read_error"],
  ])("proceeds when %s", async (_label, tables, reason) => {
    const { r } = await check(tables as Fake);
    expect(r.hold).toBe(false);
    expect(r.reason).toBe(reason);
  });
});

function fakeStep() {
  const ids: string[] = [];
  return {
    ids,
    step: {
      run: async (id: string, fn: () => Promise<MemoryGateCheck>) => {
        ids.push(id);
        return fn();
      },
      sleep: async (id: string) => {
        ids.push(id);
      },
    },
  };
}

describe("runMemoryGate", () => {
  it("does not sleep when the first look says proceed", async () => {
    const { step, ids } = fakeStep();
    const out = await runMemoryGate(step, "run-1", async () => ({ hold: false, reason: "no_memory_row", at: 0 }));
    expect(out).toEqual({ held: false, iterations: 0, reason: "no_memory_row" });
    expect(ids).toEqual(["memory-gate-0"]);
  });

  it("re-reads with unique step ids until memory is ready", async () => {
    const { step, ids } = fakeStep();
    let n = 0;
    const out = await runMemoryGate(step, "run-1", async () => {
      n += 1;
      return n < 3 ? { hold: true, reason: "hold", at: n * 5000 } : { hold: false, reason: "memory_ready", at: n * 5000 };
    });
    expect(out).toEqual({ held: true, iterations: 2, reason: "memory_ready" });
    expect(ids).toEqual(["memory-gate-0", "memory-gate-sleep-0", "memory-gate-1", "memory-gate-sleep-1", "memory-gate-2"]);
  });

  it("gives up after 3 minutes of wall clock", async () => {
    const { step } = fakeStep();
    let n = 0;
    const out = await runMemoryGate(step, "run-1", async () => ({ hold: true, reason: "hold", at: n++ * 60_000 }));
    expect(out).toEqual({ held: true, iterations: 3, reason: "timeout" });
  });

  it("gives up after 36 re-reads when time never advances", async () => {
    const { step, ids } = fakeStep();
    const out = await runMemoryGate(step, "run-1", async () => ({ hold: true, reason: "hold", at: 0 }));
    expect(out.reason).toBe("timeout");
    expect(out.iterations).toBe(MEMORY_GATE_MAX_ITERATIONS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith("memory-gate-sleep-"))).toHaveLength(36);
  });

  it("never throws: a failing step tool means proceed", async () => {
    const step = {
      run: async () => {
        throw new Error("step exhausted");
      },
      sleep: async () => {},
    };
    await expect(runMemoryGate(step, "run-1")).resolves.toEqual({ held: false, iterations: 0, reason: "read_error" });
  });
});
