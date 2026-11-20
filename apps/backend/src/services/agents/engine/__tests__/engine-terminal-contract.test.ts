
import { describe, it, expect } from "vitest";
import type { EngineEvent } from "../types";

describe("terminal EngineEvent contract", () => {
  it("(a) a terminal event WITHOUT the new optional fields is valid (today's behavior, unchanged)", () => {
    const ev: EngineEvent = {
      type: "terminal",
      resume: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    expect(ev.type).toBe("terminal");
    if (ev.type === "terminal") {
      expect(ev.costUsd).toBeUndefined();
      expect(ev.stopReason).toBeUndefined();
      expect(ev.structuredOutput).toBeUndefined();
    }
  });

  it("(b) a terminal event WITH the engine-authoritative fields carries them verbatim", () => {
    const ev: EngineEvent = {
      type: "terminal",
      resume: { kind: "sdk_session", sessionId: "sess_abc123" },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
      costUsd: 0.0421,
      stopReason: "end_turn",
      structuredOutput: { ok: true, items: [1, 2, 3] },
    };
    expect(ev.type).toBe("terminal");
    if (ev.type === "terminal") {
      expect(ev.costUsd).toBe(0.0421);
      expect(ev.stopReason).toBe("end_turn");
      expect(ev.structuredOutput).toEqual({ ok: true, items: [1, 2, 3] });
      expect(ev.resume).toEqual({ kind: "sdk_session", sessionId: "sess_abc123" });
    }
  });

  it("(c) the OTHER EngineEvent variants are unchanged (no accidental widening)", () => {
    const text: EngineEvent = { type: "text_delta", text: "hi" };
    const tool: EngineEvent = { type: "tool_call", name: "x__y", ms: 3, code: "ok", iter: 1 };
    const usage: EngineEvent = {
      type: "usage",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    expect(text.type).toBe("text_delta");
    expect(tool.type).toBe("tool_call");
    expect(usage.type).toBe("usage");
    expect(Object.keys(tool).sort()).toEqual(["code", "iter", "ms", "name", "type"]);
  });
});
