import { describe, it, expect, vi } from "vitest";
import { runSeedItem, runSeedLoop, RESERVE_USD, type LoopDeps } from "../runner";
import type { SeedStages } from "../run-card";

const stages = {} as SeedStages;
function deps(over: Partial<LoopDeps> = {}) {
  const calls: string[] = [];
  const d: LoopDeps = {
    admit: vi.fn(async (domain: string) => ({ ok: true as const, domain })),
    reserve: vi.fn(async () => "reserved" as const),
    settle: vi.fn(async (_r, dom, usd) => void calls.push(`settle:${dom}:${usd}`)),
    claim: vi.fn(async () => ({ outcome: "created" as const, id: "c1", public_id: "P", status: "running" as const })),
    getCard: vi.fn(async () => ({ id: "c1", domain: "a.com", locale: "US", parts: {}, status: "running", revoked_at: null }) as never),
    runCard: vi.fn(async () => ({ cost_usd: 0.31, score: { total: 50, out_of: 100, by_check: {} } as never })),
    finish: vi.fn(async (id, usd) => void calls.push(`finish:${id}:${usd}`)),
    fail: vi.fn(async () => undefined),
    setItem: vi.fn(async (_r, dom, p) => void calls.push(`item:${dom}:${p.state}${p.reason ? ":" + p.reason : ""}`)),
    log: () => {},
    pending: vi.fn(async () => []),
    takeLease: vi.fn(async () => true),
    memoryFreePct: vi.fn(async () => 50),
    sleep: vi.fn(async () => undefined),
    shouldStop: () => false,
    ...over,
  };
  return { d, calls };
}

describe("runSeedItem", () => {
  it("admits, reserves, claims, runs, finishes and settles to the real cost", async () => {
    const { d, calls } = deps();
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d)).toBe("done");
    expect(d.reserve).toHaveBeenCalledWith("run", "a.com", RESERVE_USD);
    expect(calls).toEqual(["item:a.com:running", "finish:c1:0.31", "settle:a.com:0.31", "item:a.com:done"]);
  });
  it("an unreachable or unsafe site is skipped before any money is held", async () => {
    const { d } = deps({ admit: async () => ({ ok: false, reason: "unsafe_url" }) });
    expect(await runSeedItem("run", { domain: "x.local", attempts: 0 }, stages, d)).toBe("skipped");
    expect(d.reserve).not.toHaveBeenCalled();
  });
  it("a suppressed domain releases its reservation and is skipped", async () => {
    const { d, calls } = deps({ claim: async () => ({ outcome: "suppressed" }) });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d)).toBe("skipped");
    expect(calls).toContain("settle:a.com:0");
    expect(d.runCard).not.toHaveBeenCalled();
  });
  it("cap reached and run closed stop the item without claiming or running", async () => {
    const a = deps({ reserve: async () => "cap_reached" });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, a.d)).toBe("cap_reached");
    expect(a.d.claim).not.toHaveBeenCalled();
    const b = deps({ claim: async () => ({ outcome: "run_closed" }) });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, b.d)).toBe("run_closed");
  });
  it("a card that finished before a crash is not run again and settles at the reservation, never zero", async () => {
    const { d, calls } = deps({ getCard: async () => ({ id: "c1", domain: "a.com", locale: "US", parts: {}, status: "done", revoked_at: null }) as never });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 1, card_id: "c1" }, stages, d)).toBe("done");
    expect(d.runCard).not.toHaveBeenCalled();
    expect(calls).toContain(`settle:a.com:${RESERVE_USD}`);
  });
  it("an item with a card is resumed without re-admission (a site briefly down does not strand it)", async () => {
    const { d } = deps({ admit: vi.fn(async () => ({ ok: false as const, reason: "unreachable" })) });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 1, card_id: "c1" }, stages, d)).toBe("done");
    expect(d.admit).not.toHaveBeenCalled();
  });
  it("a resumed card with parts already written settles at no less than the reservation", async () => {
    const { d, calls } = deps({
      getCard: async () => ({ id: "c1", domain: "a.com", locale: "US", parts: { profile: { state: "done" } }, status: "running", revoked_at: null }) as never,
    });
    await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d);
    expect(calls).toContain(`settle:a.com:${RESERVE_USD}`);
  });
  it("a manifest domain that admits as a different site is skipped", async () => {
    const { d } = deps({ admit: async () => ({ ok: true as const, domain: "other.com" }) });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d)).toBe("skipped");
    expect(d.reserve).not.toHaveBeenCalled();
  });
  it("a run closed after the reserve releases the reservation", async () => {
    const { d, calls } = deps({ claim: async () => ({ outcome: "run_closed" }) });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d)).toBe("run_closed");
    expect(calls).toContain("settle:a.com:0");
  });
  it("a bookkeeping error after the card is scored never fails the card", async () => {
    const { d } = deps({ settle: vi.fn(async () => Promise.reject(new Error("db down"))) });
    await expect(runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d)).rejects.toThrow(/db down/);
    expect(d.fail).not.toHaveBeenCalled();
  });
  it("a crash mid-card fails the card and settles at the reservation, never at zero", async () => {
    const { d, calls } = deps({ runCard: async () => Promise.reject(new Error("boom")) });
    expect(await runSeedItem("run", { domain: "a.com", attempts: 0 }, stages, d)).toBe("failed");
    expect(d.fail).toHaveBeenCalledWith("c1", "seed_failed");
    expect(calls).toContain(`settle:a.com:${RESERVE_USD}`);
  });
});

describe("runSeedLoop", () => {
  it("stops when another runner holds the lease", async () => {
    const { d } = deps({ takeLease: async () => false });
    expect((await runSeedLoop("run", stages, d, { concurrency: 2, maxAttempts: 3 })).stopped).toBe("lease_lost");
  });
  it("pauses while free memory is under 15%", async () => {
    const mem = [10, 12, 40];
    const { d } = deps({ memoryFreePct: async () => mem.shift() ?? 40 });
    await runSeedLoop("run", stages, d, { concurrency: 1, maxAttempts: 3 });
    expect(d.sleep).toHaveBeenCalledTimes(2);
  });
  it("items out of attempts are failed and do not block the rest", async () => {
    const rounds = [
      [{ domain: "stuck.com", attempts: 3 }, { domain: "ok.com", attempts: 0 }],
      [],
    ];
    const { d, calls } = deps({ pending: async () => rounds.shift() ?? [] });
    const s = await runSeedLoop("run", stages, d, { concurrency: 1, maxAttempts: 3 });
    expect(calls).toContain("item:stuck.com:failed:max_attempts");
    expect(s.done).toBe(1);
  });
  it("an item out of attempts with a card fails the card and counts its reservation as spent", async () => {
    const rounds = [[{ domain: "stuck.com", attempts: 3, card_id: "c9" }], []];
    const { d, calls } = deps({ pending: async () => rounds.shift() ?? [] });
    await runSeedLoop("run", stages, d, { concurrency: 1, maxAttempts: 3 });
    expect(d.fail).toHaveBeenCalledWith("c9", "seed_max_attempts");
    expect(calls).toContain(`settle:stuck.com:${RESERVE_USD}`);
  });
  it("one site throwing does not cut its siblings short; a whole batch throwing stops the loop", async () => {
    let n = 0;
    const { d } = deps({
      pending: async () => [{ domain: "a.com", attempts: 0 }, { domain: "b.com", attempts: 0 }],
      admit: async (domain: string) => {
        n++;
        throw new Error(`db ${domain}`);
      },
    });
    expect((await runSeedLoop("run", stages, d, { concurrency: 2, maxAttempts: 3 })).stopped).toBe("error");
    expect(n).toBe(2);
  });
  it("renews the lease during a batch and stops when a renewal is refused", async () => {
    let calls = 0;
    const slow = new Promise((r) => setTimeout(r, 40));
    const { d } = deps({
      pending: async () => [{ domain: "a.com", attempts: 0 }],
      takeLease: vi.fn(async () => ++calls === 1),
      runCard: vi.fn(async () => (await slow, { cost_usd: 0.1, score: {} as never })),
    });
    expect((await runSeedLoop("run", stages, d, { concurrency: 1, maxAttempts: 3, renewMs: 10 })).stopped).toBe("lease_lost");
    expect(calls).toBeGreaterThan(1);
  });
  it("stops at the cap", async () => {
    const { d } = deps({ pending: async () => [{ domain: "a.com", attempts: 0 }], reserve: async () => "cap_reached" });
    expect((await runSeedLoop("run", stages, d, { concurrency: 1, maxAttempts: 3 })).stopped).toBe("cap_reached");
  });
});

describe("lease renewals run one at a time", () => {
  it("a slow renewal is never overtaken, and the loop waits for it before returning", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    const slowRenew = () =>
      new Promise<boolean>((r) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          r(true);
        }, 35);
      });
    const { d } = deps({
      takeLease: vi.fn(async () => (++n === 1 ? true : slowRenew())),
      pending: async () => [{ domain: "a.com", attempts: 0 }],
      runCard: vi.fn(async () => (await new Promise((r) => setTimeout(r, 60)), { cost_usd: 0.1, score: {} as never })),
      shouldStop: () => n > 3,
    });
    await runSeedLoop("run", stages, d, { concurrency: 1, maxAttempts: 3, renewMs: 5 });
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });
});
