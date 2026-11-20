
import { describe, it, expect, vi } from "vitest";
import { withBudgetMonitor } from "../budget-monitor";
import type { EngineEvent, NormalizedUsage } from "../types";
import { shouldAbortForBudget } from "@/services/agents/budget";

const U = (input: number): NormalizedUsage => ({
  input_tokens: input,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

async function* gen(events: EngineEvent[]): AsyncIterable<EngineEvent> {
  for (const e of events) yield e;
}

async function drain(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("withBudgetMonitor", () => {
  it("under threshold: no abort, all events forwarded, accrual correct", async () => {
    const abort = new AbortController();
    const onAbortEvent = vi.fn();
    const estimateCostUsd = (_m: string, u: NormalizedUsage) => u.input_tokens / 1000;
    const events: EngineEvent[] = [
      { type: "usage", usage: U(500) },
      { type: "text_delta", text: "hi" },
      { type: "usage", usage: U(500) },
      { type: "terminal", resume: null, usage: U(0) },
    ];
    const out = await drain(
      withBudgetMonitor(gen(events), {
        headroomUsd: 10,
        reservationUsd: 0.1,
        margin: 0.5,
        model: "m",
        shouldAbortForBudget,
        estimateCostUsd,
        abort,
        onAbortEvent,
      }),
    );
    expect(onAbortEvent).not.toHaveBeenCalled();
    expect(abort.signal.aborted).toBe(false);
    expect(out).toHaveLength(4);
    expect(out.some((e) => e.type === "terminal")).toBe(true);
  });

  it("over threshold: abort fires ONCE, terminal still observed, post-abort text suppressed", async () => {
    const abort = new AbortController();
    const onAbortEvent = vi.fn();
    const estimateCostUsd = (_m: string, u: NormalizedUsage) => u.input_tokens / 1000;
    const events: EngineEvent[] = [
      { type: "usage", usage: U(9600) },
      { type: "text_delta", text: "OVER-BUDGET TURN CONTENT" },
      { type: "tool_call", name: "x__y", ms: 1, code: "ok", iter: 1 },
      { type: "terminal", resume: { kind: "sdk_session", sessionId: "s1" }, usage: U(0) },
    ];
    const out = await drain(
      withBudgetMonitor(gen(events), {
        headroomUsd: 10,
        reservationUsd: 0.1,
        margin: 0.5,
        model: "m",
        shouldAbortForBudget,
        estimateCostUsd,
        abort,
        onAbortEvent,
      }),
    );
    expect(onAbortEvent).toHaveBeenCalledTimes(1);
    expect(abort.signal.aborted).toBe(true);
    expect(out.find((e) => e.type === "text_delta")).toBeUndefined();
    expect(out.find((e) => e.type === "tool_call")).toBeUndefined();
    expect(out.find((e) => e.type === "terminal")).toBeDefined();
  });

  it("uncapped headroom (Infinity): never aborts", async () => {
    const abort = new AbortController();
    const onAbortEvent = vi.fn();
    const out = await drain(
      withBudgetMonitor(
        gen([
          { type: "usage", usage: U(1_000_000) },
          { type: "terminal", resume: null, usage: U(0) },
        ]),
        {
          headroomUsd: Infinity,
          reservationUsd: 0,
          margin: 0.5,
          model: "m",
          shouldAbortForBudget,
          estimateCostUsd: (_m, u) => u.input_tokens / 1000,
          abort,
          onAbortEvent,
        },
      ),
    );
    expect(onAbortEvent).not.toHaveBeenCalled();
    expect(abort.signal.aborted).toBe(false);
    expect(out).toHaveLength(2);
  });
});
