import { describe, it, expect } from "vitest";
import { buildSteerablePromptStream } from "../steerable-prompt";
import type { SteerMsg, SteerSource } from "../types";

async function collect<T>(
  it: AsyncIterable<T>,
  max = 50,
): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

describe("buildSteerablePromptStream", () => {
  it("with NO steerSource → yields EXACTLY one user message then closes (byte-identical)", async () => {
    const msgs = await collect(
      buildSteerablePromptStream("hello world", "sess-1"),
    );
    expect(msgs).toEqual([
      {
        type: "user",
        message: { role: "user", content: "hello world" },
        parent_tool_use_id: null,
        session_id: "sess-1",
      },
    ]);
  });

  it("with NO steerSource → never touches the signal or polls (completes synchronously-ish)", async () => {
    const ac = new AbortController();
    const msgs = await collect(
      buildSteerablePromptStream("x", "s", { signal: ac.signal, pollMs: 999999 }),
    );
    expect(msgs).toHaveLength(1);
  });

  it("with a steerSource → yields initial + each steer as an authoritative user turn, marks each AFTER delivery, exits on abort", async () => {
    const steers: SteerMsg[] = [
      { id: "a", seq: 1, body: "use the PROD account", origin: "chat", author_user_id: "u1" },
      { id: "b", seq: 2, body: "and skip the refund step", origin: "slack", author_user_id: "u1" },
    ];
    let drainCalls = 0;
    const marks: Array<{ ids: string[]; turn: number }> = [];
    const drainedEvents: Array<{ count: number; turn: number }> = [];
    const ac = new AbortController();

    const source: SteerSource = {
      drain: async (_afterSeq, _max) => {
        drainCalls += 1;
        if (drainCalls === 1) return steers;
        ac.abort();
        return [];
      },
      markDrained: async (ids, turn) => {
        marks.push({ ids, turn });
      },
    };

    const msgs = await collect(
      buildSteerablePromptStream("original task", "sess-2", {
        steerSource: source,
        signal: ac.signal,
        pollMs: 5,
        onSteerDrained: (count, turn) => drainedEvents.push({ count, turn }),
      }),
    );

    expect(msgs.map((m) => m.message.content)).toEqual([
      "original task",
      "use the PROD account",
      "and skip the refund step",
    ]);
    for (const m of msgs) {
      expect(m.type).toBe("user");
      expect(m.message.role).toBe("user");
      expect(m.parent_tool_use_id).toBeNull();
      expect(m.session_id).toBe("sess-2");
    }
    expect(marks).toEqual([
      { ids: ["a"], turn: 1 },
      { ids: ["b"], turn: 1 },
    ]);
    expect(drainedEvents).toEqual([
      { count: 1, turn: 1 },
      { count: 1, turn: 1 },
    ]);
  });

  it("once aborted mid-batch, no further steer is delivered (pre-yield abort check)", async () => {
    const steers: SteerMsg[] = [
      { id: "a", seq: 1, body: "first", origin: "chat", author_user_id: "u1" },
      { id: "b", seq: 2, body: "second", origin: "chat", author_user_id: "u1" },
    ];
    const marks: string[] = [];
    const ac = new AbortController();
    let drains = 0;
    const source: SteerSource = {
      drain: async () => (drains++ === 0 ? steers : []),
      markDrained: async (ids) => {
        marks.push(...ids);
        ac.abort();
      },
    };
    const msgs = await collect(
      buildSteerablePromptStream("t", "s5", { steerSource: source, signal: ac.signal, pollMs: 1 }),
    );
    expect(marks).toEqual(["a"]);
    expect(msgs.map((m) => m.message.content)).toEqual(["t", "first"]);
  });

  it("markDrained failure: the steer is NOT re-delivered (delivered once), and the loop backs off", async () => {
    const steers: SteerMsg[] = [
      { id: "a", seq: 1, body: "only steer", origin: "chat", author_user_id: "u1" },
    ];
    const ac = new AbortController();
    let drainCalls = 0;
    let deliveries = 0;
    const source: SteerSource = {
      drain: async (afterSeq) => {
        drainCalls += 1;
        if (afterSeq >= 1) {
          ac.abort();
          return [];
        }
        return drainCalls === 1 ? steers : [];
      },
      markDrained: async () => {
        throw new Error("mark write failed");
      },
    };
    const msgs = await collect(
      buildSteerablePromptStream("t", "s6", { steerSource: source, signal: ac.signal, pollMs: 1 }),
    );
    deliveries = msgs.filter((m) => m.message.content === "only steer").length;
    expect(deliveries).toBe(1);
    expect(msgs.map((m) => m.message.content)).toEqual(["t", "only steer"]);
  });

  it("a drain() that throws does NOT kill the stream — it backs off and the run can still abort", async () => {
    const ac = new AbortController();
    let calls = 0;
    const source: SteerSource = {
      drain: async () => {
        calls += 1;
        if (calls >= 2) ac.abort();
        throw new Error("transient DB blip");
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("t", "s3", { steerSource: source, signal: ac.signal, pollMs: 1 }),
    );
    expect(msgs).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("an already-aborted signal → yields only the initial turn (no barge-in)", async () => {
    const ac = new AbortController();
    ac.abort();
    let drainCalled = false;
    const source: SteerSource = {
      drain: async () => {
        drainCalled = true;
        return [];
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("t", "s4", { steerSource: source, signal: ac.signal }),
    );
    expect(msgs).toHaveLength(1);
    expect(drainCalled).toBe(false);
  });

  it("REGRESSION: model idle + empty drain → generator CLOSES (does not poll forever)", async () => {
    const modelIdle = { value: false };
    let drainCalls = 0;
    const source: SteerSource = {
      drain: async () => {
        drainCalls += 1;
        modelIdle.value = true;
        return [];
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("hi", "s5", {
        steerSource: source,
        pollMs: 1,
        modelIdle,
      }),
    );
    expect(msgs).toHaveLength(1);
    expect(drainCalls).toBeGreaterThanOrEqual(1);
  });

  it("model still WORKING (idle=false) → keeps the channel open, does NOT close early", async () => {
    const modelIdle = { value: false };
    const ac = new AbortController();
    let drainCalls = 0;
    const source: SteerSource = {
      drain: async () => {
        drainCalls += 1;
        if (drainCalls >= 3) ac.abort();
        return [];
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("hi", "s6", {
        steerSource: source,
        signal: ac.signal,
        pollMs: 1,
        modelIdle,
      }),
    );
    expect(msgs).toHaveLength(1);
    expect(drainCalls).toBeGreaterThanOrEqual(3);
  });

  it("barge-in still WORKS: a pending steer is delivered even though the model went idle", async () => {
    const modelIdle = { value: true };
    let drainCalls = 0;
    const source: SteerSource = {
      drain: async () => {
        drainCalls += 1;
        if (drainCalls === 1) {
          return [
            {
              id: "a",
              seq: 1,
              body: "actually use the PROD account",
              origin: "chat",
              author_user_id: "u1",
            } as SteerMsg,
          ];
        }
        modelIdle.value = true;
        return [];
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("hi", "s7", {
        steerSource: source,
        pollMs: 1,
        modelIdle,
      }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1].message.content).toBe("actually use the PROD account");
  });

  it("REGRESSION: drain throws FOREVER → gives up, closes, run finishes (never hangs)", async () => {
    const failures: Array<{ consecutive: number; degraded: boolean }> = [];
    let drainCalls = 0;
    const source: SteerSource = {
      drain: async () => {
        drainCalls += 1;
        throw new Error("drain_agent_run_steers: function does not exist");
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("hi", "s8", {
        steerSource: source,
        pollMs: 1,
        onDrainFailure: (f) =>
          failures.push({ consecutive: f.consecutive, degraded: f.degraded }),
      }),
    );
    expect(msgs).toHaveLength(1);
    expect(drainCalls).toBe(3);
    expect(failures.at(-1)).toEqual({ consecutive: 3, degraded: true });
    expect(failures).toHaveLength(3);
  });

  it("drain throws while the model is IDLE → closes immediately (nothing left to wait for)", async () => {
    const modelIdle = { value: true };
    const failures: Array<{ degraded: boolean }> = [];
    const source: SteerSource = {
      drain: async () => {
        throw new Error("supabase: connection reset");
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("hi", "s9", {
        steerSource: source,
        pollMs: 1,
        modelIdle,
        onDrainFailure: (f) => failures.push({ degraded: f.degraded }),
      }),
    );
    expect(msgs).toHaveLength(1);
    expect(failures).toEqual([{ degraded: true }]);
  });

  it("a TRANSIENT drain blip recovers → barge-in still delivers the steer", async () => {
    const modelIdle = { value: false };
    let drainCalls = 0;
    const source: SteerSource = {
      drain: async () => {
        drainCalls += 1;
        if (drainCalls === 1) throw new Error("transient blip");
        if (drainCalls === 2) {
          return [
            {
              id: "a",
              seq: 1,
              body: "switch to the other account",
              origin: "chat",
              author_user_id: "u1",
            } as SteerMsg,
          ];
        }
        modelIdle.value = true;
        return [];
      },
      markDrained: async () => {},
    };
    const msgs = await collect(
      buildSteerablePromptStream("hi", "s10", {
        steerSource: source,
        pollMs: 1,
        modelIdle,
      }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1].message.content).toBe("switch to the other account");
  });
});
