
import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import { bareUiToolName, createTranslator, encodeSse, MAX_FORWARDED_TOOL_CALLS, type ThreadEventRow } from "../ag-ui-translate";

const ctx = { threadId: "thr-1", runId: "run-1" };
const row = (id: number, kind: string, body: Record<string, unknown> = {}): ThreadEventRow => ({ id, kind, body });
const types = (evs: { type: string }[]) => evs.map((e) => e.type);

describe("createTranslator", () => {
  it("maps a full run to the expected AG-UI sequence", () => {
    const t = createTranslator(ctx);
    const out = [
      ...t.push(row(1, "run_start", { trigger: "chat" })),
      ...t.push(row(2, "plan", { title: "Look at last week" })),
      ...t.push(row(3, "reasoning", { text: "thinking" })),
      ...t.push(row(4, "tool_call", { tool_name: "web_search__search", target: '{"q":"x"}', ms: 0, code: "ok", output_preview: "" })),
      ...t.push(row(5, "tool_call", { tool_name: "web_search__search", target: "", ms: 5, code: "ok", output_preview: "3 hits" })),
      ...t.push(row(6, "tool_call", { tool_name: "mcp__ui__open_tab", target: '{"kind":"calendar"}', ms: 0, code: "ok", output_preview: "" })),
      ...t.push(row(7, "tool_call", { tool_name: "mcp__ui__open_tab", target: "", ms: 3, code: "ok", output_preview: "Done — the browser…" })),
      ...t.push(row(8, "decision", { decision_id: "d-1", decision_class: "social.publish.v2" })),
      ...t.push(row(9, "chat_assistant", { text: "Opened your calendar." })),
      ...t.push(row(10, "run_end", { status: "succeeded" })),
    ];
    expect(types(out)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.STEP_STARTED,
      EventType.CUSTOM,
      EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT,
      EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END,
      EventType.STATE_DELTA,
      EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
      EventType.STATE_DELTA,
      EventType.RUN_FINISHED,
    ]);
    expect((out[7] as { toolCallId: string }).toolCallId).toBe((out[4] as { toolCallId: string }).toolCallId);
    expect((out[7] as { content: string }).content).toBe("3 hits");
    const uiStart = out[8] as { toolCallName: string };
    const uiArgs = out[9] as { delta: string };
    expect(uiStart.toolCallName).toBe("open_tab");
    expect(JSON.parse(uiArgs.delta)).toEqual({ kind: "calendar" });
    expect(t.finished()).toBe(true);
    expect(t.push(row(11, "chat_assistant", { text: "late" }))).toEqual([]);
  });

  it("starts the run on the first row of ANY kind, and only once", () => {
    const t = createTranslator(ctx);
    expect(types(t.push(row(1, "chat_assistant", { text: "hi" })))).toEqual([
      EventType.RUN_STARTED, EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
    ]);
    expect(types(t.push(row(2, "run_start")))).toEqual([]);
  });

  it("a failed run with no assistant text → RUN_ERROR; with text → RUN_FINISHED", () => {
    const a = createTranslator(ctx);
    a.push(row(1, "run_start"));
    const endA = a.push(row(2, "run_end", { status: "failed", error: "boom" }));
    expect(types(endA)).toEqual([EventType.STATE_DELTA, EventType.RUN_ERROR]);
    expect((endA[1] as { message: string }).message).toBe("boom");

    const b = createTranslator(ctx);
    b.push(row(1, "chat_assistant", { text: "partial" }));
    expect(types(b.push(row(2, "run_end", { status: "failed" })))).toEqual([EventType.STATE_DELTA, EventType.RUN_FINISHED]);
  });

  it("caps forwarded tool calls at 200 and says so once", () => {
    const t = createTranslator(ctx);
    t.push(row(0, "run_start"));
    let forwarded = 0;
    let truncations = 0;
    for (let i = 1; i <= MAX_FORWARDED_TOOL_CALLS + 5; i++) {
      const evs = t.push(row(i, "tool_call", { tool_name: `x__y${i}`, target: "{}", ms: 0, code: "ok", output_preview: "" }));
      forwarded += evs.filter((e) => e.type === EventType.TOOL_CALL_START).length;
      truncations += evs.filter((e) => e.type === EventType.CUSTOM && (e as { name: string }).name === "zavi.tool_calls_truncated").length;
    }
    expect(forwarded).toBe(MAX_FORWARDED_TOOL_CALLS);
    expect(truncations).toBe(1);
  });

  it("ignores kinds the copilot stream has no use for", () => {
    const t = createTranslator(ctx);
    t.push(row(1, "run_start"));
    expect(t.push(row(2, "file_edit", { path: "a.ts", diff: "-" }))).toEqual([]);
    expect(t.push(row(3, "voice_turn_state", {}))).toEqual([]);
  });
});

describe("bareUiToolName", () => {
  it("strips the SDK/ui prefixes and flags only the gated frontend names", () => {
    expect(bareUiToolName("mcp__ui__open_tab")).toEqual({ name: "open_tab", isFrontend: true });
    expect(bareUiToolName("ui__open_agent")).toEqual({ name: "open_agent", isFrontend: true });
    expect(bareUiToolName("mcp__ui__show_chart")).toEqual({ name: "show_chart", isFrontend: false });
    expect(bareUiToolName("web_search__search")).toEqual({ name: "web_search__search", isFrontend: false });
  });
});

describe("encodeSse", () => {
  it("frames one event per data: line with a blank line after", () => {
    expect(encodeSse({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as never)).toBe(
      'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n',
    );
  });
});
