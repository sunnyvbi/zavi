
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { readRunStatusAndTenant } from "./runner";

export const MEMORY_GATE_MAX_ITERATIONS = 36;
export const MEMORY_GATE_SLEEP = "5s";
export const MEMORY_GATE_MAX_MS = 3 * 60_000;
export const MEMORY_GATE_TENANT_MAX_AGE_MS = 15 * 60_000;

export type MemoryGateReason =
  | "hold"
  | "run_not_queued"
  | "no_memory_row"
  | "memory_ready"
  | "memory_failed"
  | "tenant_old"
  | "read_error";

export type MemoryGateCheck = {
  hold: boolean;
  reason: MemoryGateReason;
  at: number;
};

export type MemoryGateReaders = {
  readRun: (run_id: string) => Promise<{ status: string; tenant_id: string } | null>;
  readMemoryStatus: (tenant_id: string) => Promise<"pending" | "ready" | "failed" | null>;
  readTenantCreatedAt: (tenant_id: string) => Promise<string | null>;
};

async function readTenantCreatedAt(tenant_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenants")
    .select("created_at")
    .maybeSingle();
  if (error) throw new Error(`tenants read failed: ${error.message}`);
  return (data as { created_at?: string } | null)?.created_at ?? null;
}

const DEFAULT_READERS: MemoryGateReaders = {
  readRun: (run_id) => readRunStatusAndTenant(run_id),
  readMemoryStatus: async (tid) => (await import("@/services/onboarding/background-memory")).readMemoryStatus(tid),
  readTenantCreatedAt,
};

export async function checkMemoryGate(
  run_id: string,
  opts: { readers?: Partial<MemoryGateReaders>; now?: () => number } = {},
): Promise<MemoryGateCheck> {
  const now = opts.now ?? Date.now;
  const r = { ...DEFAULT_READERS, ...opts.readers };
  const at = now();
  try {
    const run = await r.readRun(run_id);
    if (!run || run.status !== "queued" || !run.tenant_id) {
      return { hold: false, reason: "run_not_queued", at };
    }

    const status = await r.readMemoryStatus(run.tenant_id);
    if (status === "ready") return { hold: false, reason: "memory_ready", at };
    if (status === "failed") return { hold: false, reason: "memory_failed", at };
    if (status !== "pending") return { hold: false, reason: "no_memory_row", at };

    const createdMs = Date.parse((await r.readTenantCreatedAt(run.tenant_id)) ?? "");
    if (!Number.isFinite(createdMs) || at - createdMs >= MEMORY_GATE_TENANT_MAX_AGE_MS) {
      return { hold: false, reason: "tenant_old", at };
    }
    return { hold: true, reason: "hold", at };
  } catch {
    return { hold: false, reason: "read_error", at };
  }
}

export type MemoryGateStep = {
  run: (id: string, fn: () => Promise<MemoryGateCheck>) => Promise<unknown>;
  sleep: (id: string, duration: string) => Promise<unknown>;
};

export async function runMemoryGate(
  step: MemoryGateStep,
  run_id: string,
  check: (run_id: string) => Promise<MemoryGateCheck> = (id) => checkMemoryGate(id),
): Promise<{ held: boolean; iterations: number; reason: MemoryGateReason | "timeout" }> {
  try {
    const first = (await step.run("memory-gate-0", () => check(run_id))) as MemoryGateCheck;
    if (!first.hold) return { held: false, iterations: 0, reason: first.reason };
    let last = first;
    for (let i = 0; i < MEMORY_GATE_MAX_ITERATIONS; i++) {
      await step.sleep(`memory-gate-sleep-${i}`, MEMORY_GATE_SLEEP);
      last = (await step.run(`memory-gate-${i + 1}`, () => check(run_id))) as MemoryGateCheck;
      if (!last.hold) return { held: true, iterations: i + 1, reason: last.reason };
      if (last.at - first.at >= MEMORY_GATE_MAX_MS) {
        return { held: true, iterations: i + 1, reason: "timeout" };
      }
    }
    return { held: true, iterations: MEMORY_GATE_MAX_ITERATIONS, reason: "timeout" };
  } catch {
    return { held: false, iterations: 0, reason: "read_error" };
  }
}
