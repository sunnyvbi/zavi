import { describe, it, expect, vi, beforeEach } from "vitest";

const getBoolSettingMock = vi.fn();
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...args: unknown[]) => getBoolSettingMock(...args),
}));

const insertMock = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ insert: insertMock }) }),
}));

import { writeMemorySignal } from "../write-signal";

const base = {
  run_id: "run-1",
  row: {
    agent_slug: "operator",
    tenant_id: "t-1",
    trigger: "manual",
    started_at: "2026-07-01T00:00:00Z",
    finished_at: "2026-07-01T00:01:00Z",
    payload: { question: "what is MRR?" },
  },
  update: { status: "finished", output_text: "…", cost_usd: 0.1, tool_calls: [] },
} as const;

beforeEach(() => {
  insertMock.mockClear();
  getBoolSettingMock.mockReset();
  getBoolSettingMock.mockResolvedValue(false);
});

const provenanceOf = () => insertMock.mock.calls[0][0].provenance;

describe("writeMemorySignal — failure_shapes presence is the signal", () => {
  it("EMPTY array ⇒ key PRESENT as [] (a clean run is readable as clean)", async () => {
    await writeMemorySignal({ ...base, failureShapes: [] } as never);
    const p = provenanceOf();
    expect(p).toHaveProperty("failure_shapes");
    expect(p.failure_shapes).toEqual([]);
  });

  it("non-empty array ⇒ key present with the whitelisted tags", async () => {
    await writeMemorySignal({
      ...base,
      failureShapes: ["metric-mislabel", "dead-end-punt"],
    } as never);
    expect(provenanceOf().failure_shapes).toEqual([
      "metric-mislabel",
      "dead-end-punt",
    ]);
  });

  it("UNDEFINED ⇒ key ABSENT (tagger never ran — distinct from clean)", async () => {
    await writeMemorySignal(base as never);
    expect(provenanceOf()).not.toHaveProperty("failure_shapes");
  });

  it("whitelist still enforced — an unknown tag is filtered out, key stays present", async () => {
    await writeMemorySignal({
      ...base,
      failureShapes: ["metric-mislabel", "not-a-real-shape"],
    } as never);
    expect(provenanceOf().failure_shapes).toEqual(["metric-mislabel"]);
  });

  it("an all-unknown list still writes [] — ran-and-clean, not never-ran", async () => {
    await writeMemorySignal({
      ...base,
      failureShapes: ["not-a-real-shape"],
    } as never);
    const p = provenanceOf();
    expect(p).toHaveProperty("failure_shapes");
    expect(p.failure_shapes).toEqual([]);
  });
});
