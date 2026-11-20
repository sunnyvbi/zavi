import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn(async () => ({ ids: ["e"] })) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: sendMock } }));
const { enabledMock } = vi.hoisted(() => ({ enabledMock: vi.fn(async () => true) }));
const { numberMock } = vi.hoisted(() => ({ numberMock: vi.fn(async (key: string): Promise<number> => (key === "team_note_tool_loop_threshold" ? 3 : 10)) }));
vi.mock("@/services/settings", () => ({ getBoolSetting: enabledMock, getNumberSetting: numberMock }));

import { emitTeamNoteRunEnd } from "../emit-run-end";

const base = {
  runId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  agentSlug: "operator",
  trigger: "chat",
  paused: false,
  status: "success",
  error: null as string | null,
  willRetry: false,
  toolCalls: [
    { name: "t", status: "tool_error", code: "x" },
    { name: "t", status: "tool_error", code: "x" },
  ],
  groundingFlags: [],
  operatorShapes: [],
};
const sent = () => (sendMock.mock.calls[0] as unknown[])[0] as { name: string; data: Record<string, unknown> };

beforeEach(() => {
  sendMock.mockClear();
  enabledMock.mockResolvedValue(true);
  numberMock.mockReset();
  numberMock.mockImplementation(async (key: string) => (key === "team_note_tool_loop_threshold" ? 3 : 10));
});

describe("emitTeamNoteRunEnd", () => {
  it("normal: one event, no tenant_id, signals sorted by precedence", async () => {
    await emitTeamNoteRunEnd({ ...base, groundingFlags: [{ pattern: "p", severity: "hard" }] });
    expect(sent().name).toBe("team_note.candidate");
    expect(sent().data).toMatchObject({ run_id: base.runId, source: "run_end", signals: ["hard_grounding_flag", "tool_repeat_failure"] });
    expect(sent().data).not.toHaveProperty("tenant_id");
    expect(String(sent().data.fingerprint)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("20 different queries plus 2 recovered guard refusals: no team-note offer", async () => {
    const toolCalls = [
      ...Array.from({ length: 20 }, (_, i) => ({ name: "operator_db__query", status: "ok", input_preview: `{"q":${i}}` })),
      { name: "operator_db__query", status: "tool_error", code: "data_access_refused", input_preview: '{"q":"hidden"}' },
      { name: "operator_db__query", status: "tool_error", code: "operator_db_read_rejected", input_preview: '{"q":"big"}' },
    ];
    await emitTeamNoteRunEnd({ ...base, toolCalls });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("same tool + same input 3x is still offered", async () => {
    const same = { name: "operator_db__query", status: "ok", input_preview: '{"q":1}' };
    await emitTeamNoteRunEnd({ ...base, toolCalls: [same, same, same] });
    expect(sent().data.signals).toEqual(["tool_loop"]);
  });

  it("failed run with an error: run_failed", async () => {
    await emitTeamNoteRunEnd({ ...base, status: "dispatch_error", error: "model call failed", toolCalls: [] });
    expect(sent().data.signals).toEqual(["run_failed"]);
  });

  it.each([
    ["slack trigger", { trigger: "slack" }],
    ["cron trigger", { trigger: "cron" }],
    ["paused run", { paused: true }],
    ["clean run", { toolCalls: [] }],
    ["cancelled", { status: "cancelled", error: null, toolCalls: [] }],
    ["user stop error", { status: "dispatch_error", error: "run_cancelled", toolCalls: [] }],
    ["insufficient credits", { status: "dispatch_error", error: "insufficient_credits: balance 0", toolCalls: [] }],
    ["usage limit", { status: "dispatch_error", error: "usage limit reached, resets at 5pm", toolCalls: [] }],
    ["retried failure", { status: "dispatch_error", error: "boot_reap", willRetry: true, toolCalls: [] }],
  ])("no emit: %s", async (_l, patch) => {
    await emitTeamNoteRunEnd({ ...base, ...patch });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("looping run: tool_loop, with the tunable threshold read from settings", async () => {
    const loop = Array.from({ length: 4 }, () => ({ name: "q", status: "ok", input_preview: "same" }));
    await emitTeamNoteRunEnd({ ...base, toolCalls: loop });
    expect(sent().data.signals).toEqual(["tool_loop"]);
    sendMock.mockClear();
    numberMock.mockImplementation(async (key: string) => (key === "team_note_tool_loop_threshold" ? 5 : 10));
    await emitTeamNoteRunEnd({ ...base, toolCalls: loop });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a settings read failure falls back to the default thresholds", async () => {
    numberMock.mockRejectedValue(new Error("settings down"));
    await emitTeamNoteRunEnd({ ...base, toolCalls: Array.from({ length: 3 }, () => ({ name: "q", status: "ok", input_preview: "same" })) });
    expect(sent().data.signals).toEqual(["tool_loop"]);
  });

  it("no emit when the tenant turned the feature off", async () => {
    enabledMock.mockResolvedValue(false);
    await emitTeamNoteRunEnd(base);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("inngest down"));
    enabledMock.mockRejectedValueOnce(new Error("settings down"));
    await expect(emitTeamNoteRunEnd(base)).resolves.toBeUndefined();
  });
});
