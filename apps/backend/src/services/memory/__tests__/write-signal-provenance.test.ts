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

const args = {
  run_id: "run-1",
  row: {
    agent_slug: "engineer",
    tenant_id: "t-1",
    trigger: "manual",
    started_at: "2026-07-01T00:00:00Z",
    finished_at: "2026-07-01T00:01:00Z",
    payload: { question: "fix deploy?" },
  },
  update: {
    status: "finished",
    output_text: "done",
    cost_usd: 0.1,
    tool_calls: [
      { name: "github__list_runs", input_preview: "i", output_preview: "o", ms: 5, status: "ok", returned_ids: ["run-0001", "run-0002"] },
      { name: "web_fetch", input_preview: "i", output_preview: "o", ms: 5, status: "tool_error", code: "http_403" },
    ],
  },
} as const;

beforeEach(() => {
  insertMock.mockClear();
  getBoolSettingMock.mockReset();
});

describe("writeMemorySignal P0.1 provenance flag-wiring", () => {
  it("flag OFF ⇒ trajectory carries no provenance keys (pre-P0.1 byte shape)", async () => {
    getBoolSettingMock.mockResolvedValue(false);
    await writeMemorySignal(args as never);
    const row = insertMock.mock.calls[0][0];
    expect(Object.keys(row.redacted_trajectory)).toEqual(
      expect.not.arrayContaining(["connectors_used", "candidate_sources_checked", "candidate_dead_ends"]),
    );
  });

  it("flag ON ⇒ trajectory carries the derived provenance block", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    await writeMemorySignal(args as never);
    expect(getBoolSettingMock).toHaveBeenCalledWith("memory_episode_provenance", "t-1");
    const row = insertMock.mock.calls[0][0];
    expect(row.redacted_trajectory.connectors_used).toEqual(["github", "web_fetch"]);
    expect(row.redacted_trajectory.candidate_sources_checked).toEqual([
      { tool: "github__list_runs", returned_ids: ["run-0001", "run-0002"], returned_count: 2 },
    ]);
    expect(row.redacted_trajectory.candidate_dead_ends).toEqual([
      { tool: "web_fetch", code: "http_403" },
    ]);
    expect(JSON.stringify(row.redacted_trajectory.candidate_sources_checked)).not.toContain("input_preview");
  });

  it("settings-read throw ⇒ provenance omitted, episode still written (hot path)", async () => {
    getBoolSettingMock.mockRejectedValue(new Error("db down"));
    await writeMemorySignal(args as never);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0];
    expect(row.redacted_trajectory).not.toHaveProperty("connectors_used");
  });
});
