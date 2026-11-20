
import { describe, it, expect, vi, beforeEach } from "vitest";

type Insert = { table: string; row: Record<string, unknown> };
const inserts: Insert[] = [];
let runRow: Record<string, unknown> | null = {
  tenant_id: "tenant-1",
  agent_slug: "operator",
  trigger: "chat",
};
let insertError: { message: string } | null = null;
let scratchpadRows: unknown[] = [];

function makeStub() {
  const chain: Record<string, unknown> = {};
  let currentTable = "";
  const self = () => chain;
  chain.from = (t: string) => {
    currentTable = t;
    return chain;
  };
  chain.select = self;
  chain.eq = self;
  chain.order = self;
  chain.limit = async () => ({ data: scratchpadRows, error: null });
  chain.single = async () => ({ data: runRow, error: runRow ? null : { message: "not found" } });
  chain.insert = async (row: Record<string, unknown>) => {
    inserts.push({ table: currentTable, row });
    return { error: insertError };
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => makeStub(),
}));

import { writeOperatorStep, readOperatorStepScratchpad } from "../write-signal";

beforeEach(() => {
  inserts.length = 0;
  runRow = { tenant_id: "tenant-1", agent_slug: "operator", trigger: "chat" };
  insertError = null;
  scratchpadRows = [];
});

describe("writeOperatorStep", () => {
  it("inserts an operator_step row with re-derived tenant/slug/trigger", async () => {
    await writeOperatorStep({
      run_id: "run-1",
      step_idx: 0,
      plan_md: "tier3 handoff to cto",
      observations_md: "DOM showed 6 areas",
      decisions_md: "hand off",
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0].row;
    expect(row.signal_kind).toBe("operator_step");
    expect(row.step_idx).toBe(0);
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.agent_slug).toBe("operator");
    expect(row.trigger).toBe("chat");
    expect(row.status).toBe("success");
  });

  it("redacts PII in step bodies before insert", async () => {
    await writeOperatorStep({
      run_id: "run-1",
      step_idx: 1,
      observations_md: "customer alice@example.com complained",
    });
    const traj = inserts[0].row.redacted_trajectory as Record<string, unknown>;
    expect(JSON.stringify(traj)).not.toMatch(/alice@example\.com/);
  });

  it("no-ops silently when the run row is gone (deleted mid-flight)", async () => {
    runRow = null;
    await writeOperatorStep({ run_id: "run-gone", step_idx: 0, plan_md: "x" });
    expect(inserts).toHaveLength(0);
  });

  it("throws on unexpected insert error (caller catches best-effort)", async () => {
    insertError = { message: "boom" };
    await expect(
      writeOperatorStep({ run_id: "run-1", step_idx: 0, plan_md: "x" }),
    ).rejects.toThrow(/operator_step insert failed/);
  });

  it("handles all-null step bodies (records an empty step)", async () => {
    await writeOperatorStep({ run_id: "run-1", step_idx: 2 });
    expect(inserts).toHaveLength(1);
    const traj = inserts[0].row.redacted_trajectory as Record<string, unknown>;
    expect(traj.plan_md).toBeNull();
    expect(traj.observations_md).toBeNull();
    expect(traj.decisions_md).toBeNull();
  });
});

describe("readOperatorStepScratchpad", () => {
  it("returns rows newest-first from the stub", async () => {
    scratchpadRows = [
      { step_idx: 2, redacted_trajectory: { plan_md: "c" } },
      { step_idx: 1, redacted_trajectory: { plan_md: "b" } },
      { step_idx: 0, redacted_trajectory: { plan_md: "a" } },
    ];
    const rows = await readOperatorStepScratchpad("run-1");
    expect(rows).toHaveLength(3);
    expect(rows[0].step_idx).toBe(2);
  });

  it("returns [] on empty scratchpad", async () => {
    scratchpadRows = [];
    const rows = await readOperatorStepScratchpad("run-1");
    expect(rows).toEqual([]);
  });

  it("returns [] (fail-safe) when the query errors", async () => {
    const errStub = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: null, error: { message: "db down" } }),
              }),
            }),
          }),
        }),
      }),
    };
    const rows = await readOperatorStepScratchpad("run-1", errStub as never);
    expect(rows).toEqual([]);
  });
});
