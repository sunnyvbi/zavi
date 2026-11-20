
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EngineEvent, NormalizedUsage } from "../types";

const captured = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (_table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        captured.rows.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { makeEmitProgress } from "@/services/agents/progress";
import { makeOnEventHandler } from "../on-event-writer";

beforeEach(() => {
  captured.rows = [];
});

const ZERO_USAGE: NormalizedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("makeOnEventHandler — C14 chokepoint", () => {
  it("tool_call event with smuggled extra keys → meta is ONLY {tool_name,ms,code,iter}", async () => {
    const threadEvents: unknown[] = [];
    const onEvent = makeOnEventHandler({
      emitProgress: makeEmitProgress("run-1", "tenant-1"),
      safeEmitThreadEvent: async (a) => {
        threadEvents.push(a);
      },
      ctx: {
        agent_run_id: "run-1",
        agent_slug: "operator",
        tenant_id: "tenant-1",
        thread_id: "th-1",
      },
    });

    const dirty = {
      type: "tool_call",
      name: "slack__post_message",
      ms: 42,
      code: "ok",
      iter: 7,
      output: "SECRET MODEL OUTPUT",
      prompt: "the full system prompt",
      input: "user PII",
    } as unknown as EngineEvent;

    onEvent(dirty);
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.rows.length).toBe(1);
    const meta = captured.rows[0].meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["code", "iter", "ms", "tool_name"]);
    expect(meta.tool_name).toBe("slack__post_message");
    expect(meta.ms).toBe(42);
    expect(meta.code).toBe("ok");
    expect(meta.iter).toBe(7);

    const serialized = JSON.stringify(captured.rows[0]);
    for (const leak of ["SECRET MODEL OUTPUT", "the full system prompt", "user PII"]) {
      expect(serialized).not.toContain(leak);
    }

    expect(threadEvents).toHaveLength(1);
    const te = threadEvents[0] as { body: Record<string, unknown> };
    expect(te.body.output_preview).toBe("");
    expect(te.body.code).toBe("ok");
  });

  it("deny-coded tool_call → tool_use_errored stage + thread_event code 'err'", async () => {
    const threadEvents: Array<{ body: { code: string } }> = [];
    const onEvent = makeOnEventHandler({
      emitProgress: makeEmitProgress("run-2", "tenant-2"),
      safeEmitThreadEvent: async (a) => {
        threadEvents.push(a as { body: { code: string } });
      },
      ctx: { agent_run_id: "run-2", agent_slug: "pm", tenant_id: "tenant-2", thread_id: null },
    });
    onEvent({ type: "tool_call", name: "web_fetch__fetch", ms: 0, code: "egress_denied_coresident", iter: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.rows[0].stage).toBe("tool_use_errored");
    expect((captured.rows[0].meta as Record<string, unknown>).code).toBe("egress_denied_coresident");
    expect(threadEvents[0].body.code).toBe("err");
  });

  it("steer_drained → ONE body-free row on the DEDICATED stage (not a tool_use_* stage)", async () => {
    const threadEvents: unknown[] = [];
    const onEvent = makeOnEventHandler({
      emitProgress: makeEmitProgress("run-s", "tenant-s"),
      safeEmitThreadEvent: async (a) => {
        threadEvents.push(a);
      },
      ctx: { agent_run_id: "run-s", agent_slug: "operator", tenant_id: "tenant-s", thread_id: "th-s" },
    });

    onEvent({
      type: "steer_drained",
      count: 3,
      iter: 4,
      body: "use the PROD stripe account not test",
    } as unknown as EngineEvent);
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.rows.length).toBe(1);
    expect(captured.rows[0].stage).toBe("steer_drained");
    const toolStages = ["tool_use_started", "tool_use_completed", "tool_use_errored"];
    expect(toolStages).not.toContain(captured.rows[0].stage);
    const meta = captured.rows[0].meta as Record<string, unknown>;
    expect(meta.iter).toBe(4);
    expect(Object.keys(meta)).not.toContain("tool_name");
    const serialized = JSON.stringify(captured.rows[0]);
    expect(serialized).not.toContain("PROD stripe");
    expect(serialized).not.toContain("\"count\"");
    expect(threadEvents).toHaveLength(0);
  });

  it("steer_drained with count 0 writes nothing (no phantom progress row)", async () => {
    const onEvent = makeOnEventHandler({
      emitProgress: makeEmitProgress("run-s0", "tenant-s0"),
      safeEmitThreadEvent: async () => {},
      ctx: { agent_run_id: "run-s0", agent_slug: "pm", tenant_id: "tenant-s0", thread_id: null },
    });
    onEvent({ type: "steer_drained", count: 0, iter: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.rows.length).toBe(0);
  });

  it("usage + terminal events route to the injected callbacks (no meta write)", async () => {
    let usageSeen: NormalizedUsage | null = null;
    let terminalSeen = false;
    const onEvent = makeOnEventHandler({
      emitProgress: makeEmitProgress("run-3", "tenant-3"),
      safeEmitThreadEvent: async () => {},
      ctx: { agent_run_id: "run-3", agent_slug: "qa", tenant_id: "tenant-3", thread_id: null },
      onUsage: (u) => {
        usageSeen = u;
      },
      onTerminal: () => {
        terminalSeen = true;
      },
    });
    onEvent({ type: "usage", usage: { ...ZERO_USAGE, input_tokens: 100 } });
    onEvent({ type: "terminal", resume: { kind: "sdk_session", sessionId: "s1" }, usage: ZERO_USAGE });
    await new Promise((r) => setTimeout(r, 0));

    expect(usageSeen).toMatchObject({ input_tokens: 100 });
    expect(terminalSeen).toBe(true);
    expect(captured.rows.length).toBe(0);
  });
});
