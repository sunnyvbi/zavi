import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { method: string; args: unknown[] };
const calls: Call[][] = [];
const results: unknown[] = [];

function builder() {
  const log: Call[] = [];
  calls.push(log);
  const b: Record<string, unknown> = {};
  for (const method of ["update", "insert", "select", "eq", "lt", "order", "limit"]) {
    b[method] = (...args: unknown[]) => (log.push({ method, args }), b);
  }
  for (const method of ["single", "maybeSingle"]) {
    b[method] = (...args: unknown[]) => (log.push({ method, args }), Promise.resolve(results.shift()));
  }
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(results.shift()).then(resolve, reject);
  return b;
}

vi.mock("@/services/tenant-client", () => ({ globalClient: () => ({ from: () => builder() }) }));

import { AlreadyRunningError, finishRun, heartbeat, startRun } from "../runs";

beforeEach(() => {
  calls.length = 0;
  results.length = 0;
});

const input = { scriptKey: "creator-send", args: { batch: "b1" }, lockKey: "*", runBy: "u1", runByEmail: "s@z.com" };

describe("admin script runs", () => {
  it("a unique-index conflict becomes AlreadyRunningError with the running run's id", async () => {
    results.push({ data: [], error: null });
    results.push({ data: null, error: { code: "23505", message: "duplicate key" } });
    results.push({ data: { id: "run-9" }, error: null });
    const err = await startRun(input).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).runId).toBe("run-9");
  });

  it("heartbeat and finish only touch a row that is still running", async () => {
    results.push({ error: null }, { error: null });
    await heartbeat("run-1", { sent: 1 });
    await finishRun("run-1", { status: "done", summary: { sent: 1 } });
    for (const log of calls) {
      expect(log).toContainEqual({ method: "eq", args: ["id", "run-1"] });
      expect(log).toContainEqual({ method: "eq", args: ["status", "running"] });
    }
  });
});
