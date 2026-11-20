
import { describe, expect, it } from "vitest";
import { conductorRunIdOf, stoppedConductorReason } from "@/services/agents/conductor-child-guard";
import { isConductorChild, willBeInfraRetried } from "@/services/agents/infra-retry";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const C = "c0a1b2c3-0000-4000-8000-000000000000";

function client(rows: Record<string, unknown>[], opts: { error?: string; throws?: boolean } = {}) {
  const reads: [string, unknown][][] = [];
  return {
    reads,
    from(table: string) {
      if (opts.throws) throw new Error("db down");
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const filters: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        maybeSingle: async () => {
          reads.push(filters);
          if (opts.error) return { data: null, error: { message: opts.error } };
          const row = rows.find((r) => filters.every(([k, v]) => r[k] === v));
          return { data: row ? { status: row.status } : null, error: null };
        },
      };
      return q;
    },
  };
}

const child = (payload: unknown) => ({ tenant_id: T, payload });

describe("conductorRunIdOf", () => {
  it("reads the conductor id the conductor stamps on its children", () => {
    expect(conductorRunIdOf({ build_conductor_run_id: C })).toBe(C);
    expect(conductorRunIdOf({ build_conductor_run_id: "" })).toBeNull();
    expect(conductorRunIdOf({ build_conductor_run_id: 7 })).toBeNull();
    expect(conductorRunIdOf({})).toBeNull();
    expect(conductorRunIdOf(null)).toBeNull();
    expect(conductorRunIdOf("x")).toBeNull();
  });
});

describe("stoppedConductorReason", () => {
  for (const status of ["failed", "done", "halted"]) {
    it(`stops a child whose build is ${status}`, async () => {
      const sb = client([{ id: C, tenant_id: T, status }]);
      await expect(stoppedConductorReason(sb, child({ build_conductor_run_id: C }))).resolves.toMatch(
        new RegExp(`conductor_stopped: .*${status}`),
      );
    });
  }

  for (const status of ["active", "paused"]) {
    it(`lets a child of a ${status} build run`, async () => {
      const sb = client([{ id: C, tenant_id: T, status }]);
      await expect(stoppedConductorReason(sb, child({ build_conductor_run_id: C }))).resolves.toBeNull();
    });
  }

  it("reads the conductor only within the run's own tenant", async () => {
    const sb = client([{ id: C, tenant_id: OTHER, status: "failed" }]);
    await expect(stoppedConductorReason(sb, child({ build_conductor_run_id: C }))).resolves.toBeNull();
    expect(sb.reads[0]).toEqual([
      ["id", C],
      ["tenant_id", T],
    ]);
  });

  it("never reads anything for a run that is not a conductor child", async () => {
    const sb = client([]);
    await expect(stoppedConductorReason(sb, child({ repo_hint: "o/r" }))).resolves.toBeNull();
    expect(sb.reads).toHaveLength(0);
  });

  it("fails open on a read error, a throw, or a missing conductor", async () => {
    await expect(stoppedConductorReason(client([], { error: "timeout" }), child({ build_conductor_run_id: C }))).resolves.toBeNull();
    await expect(stoppedConductorReason(client([], { throws: true }), child({ build_conductor_run_id: C }))).resolves.toBeNull();
    await expect(stoppedConductorReason(client([]), child({ build_conductor_run_id: C }))).resolves.toBeNull();
  });
});

describe("infra-retry leaves a conductor child to its conductor", () => {
  const row = {
    id: "r1",
    tenant_id: T,
    agent_slug: "engineer",
    status: "dispatch_error",
    error: "dispatch failed — Inngest exhausted retries",
    infra_retry_count: 0,
    last_progress_at: null as string | null,
    trigger: "a2a",
  };
  it("re-fires an unmarked infra orphan as before, never a conductor child", () => {
    expect(willBeInfraRetried(row)).toBe(true);
    expect(willBeInfraRetried({ ...row, conductor_run_id: C })).toBe(false);
    expect(isConductorChild({ conductor_run_id: C })).toBe(true);
    expect(isConductorChild({ conductor_run_id: " " })).toBe(false);
    expect(isConductorChild({})).toBe(false);
  });
});
