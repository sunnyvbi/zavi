
import { describe, it, expect } from "vitest";
import { yieldToEventLoop } from "../event-loop-yield";

function burnCpu(ms: number): void {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sqrt(x + 1);
  }
  if (x === Number.NEGATIVE_INFINITY) throw new Error("unreachable");
}

async function runDispatchLoop(opts: {
  iterations: number;
  burstMs: number;
  yieldEachIter: boolean;
}): Promise<void> {
  for (let i = 0; i < opts.iterations; i++) {
    if (opts.yieldEachIter) await yieldToEventLoop();
    burnCpu(opts.burstMs);
  }
}

describe("yieldToEventLoop", () => {
  it("resolves on the next loop tick, after pending I/O (setImmediate semantics)", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("pending-io"));
    await yieldToEventLoop();
    order.push("after-yield");
    expect(order).toEqual(["pending-io", "after-yield"]);
  });

  it("keeps a concurrent request RESPONSIVE while a CPU-bursty build loop runs (the fix)", async () => {
    let firedAt = 0;
    const scheduledAt = Date.now();
    const requestServiced = new Promise<void>((resolve) => {
      setTimeout(() => {
        firedAt = Date.now();
        resolve();
      }, 5);
    });

    const loop = runDispatchLoop({
      iterations: 30,
      burstMs: 10,
      yieldEachIter: true,
    });

    await Promise.all([loop, requestServiced]);

    const lag = firedAt - scheduledAt;
    expect(lag).toBeLessThan(120);
  });

  it("WITHOUT the yield, the same loop STARVES the concurrent request (regression guard)", async () => {
    let firedAt = 0;
    const scheduledAt = Date.now();
    const requestServiced = new Promise<void>((resolve) => {
      setTimeout(() => {
        firedAt = Date.now();
        resolve();
      }, 5);
    });

    const loop = runDispatchLoop({
      iterations: 30,
      burstMs: 10,
      yieldEachIter: false,
    });

    await Promise.all([loop, requestServiced]);

    const lag = firedAt - scheduledAt;
    expect(lag).toBeGreaterThan(200);
  });
});
