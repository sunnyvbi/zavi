
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  ledger: new Map<string, number>(),
  setting: 0,
  fail: false,
}));

vi.mock("@/services/settings", () => ({ getNumberSetting: vi.fn(async () => H.setting) }));
vi.mock("@/services/tenant-client", () => ({
  startCardRpc: vi.fn(async (name: string, a: Record<string, unknown>) => {
    if (H.fail) return { data: null, error: { message: "db down" } };
    const day = a.p_day as string;
    const cur = H.ledger.get(day) ?? 0;
    await Promise.resolve();
    if (name === "start_card_budget_reserve") {
      const amt = a.p_amount as number;
      const now = H.ledger.get(day) ?? 0;
      if (amt > 0 && now + amt <= (a.p_ceiling as number)) {
        H.ledger.set(day, now + amt);
        return { data: true, error: null };
      }
      return { data: false, error: null };
    }
    if (name === "start_card_budget_adjust") {
      const next = Math.max(0, cur + (a.p_delta as number));
      H.ledger.set(day, next);
      return { data: next, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  }),
}));

import {
  START_CARD_RESERVE_USD,
  budgetDay,
  defaultDailyCeilingUsd,
  releaseCardBudget,
  reserveCardBudget,
  resolveDailyCeilingUsd,
  settleCardBudget,
} from "../budget";

const OCT_1 = new Date("2026-10-01T12:00:00Z");

beforeEach(() => {
  H.ledger.clear();
  H.setting = 0;
  H.fail = false;
});

describe("ceiling", () => {
  it("is $900/day for launch week 13-19 Oct (UTC) and $50 otherwise", () => {
    expect(defaultDailyCeilingUsd(new Date("2026-10-12T23:59:59Z"))).toBe(50);
    expect(defaultDailyCeilingUsd(new Date("2026-10-13T00:00:00Z"))).toBe(900);
    expect(defaultDailyCeilingUsd(new Date("2026-10-19T23:59:59Z"))).toBe(900);
    expect(defaultDailyCeilingUsd(new Date("2026-10-20T00:00:00Z"))).toBe(50);
  });

  it("start_card_daily_usd overrides the date-based default when above 0", async () => {
    expect(await resolveDailyCeilingUsd(OCT_1)).toBe(50);
    H.setting = 3;
    expect(await resolveDailyCeilingUsd(OCT_1)).toBe(3);
  });
});

describe("reserve", () => {
  it("refuses once the ceiling would be exceeded (a $1 ceiling fits one $1 card; with $2 the 3rd queues)", async () => {
    H.setting = 2;
    expect((await reserveCardBudget(OCT_1)).ok).toBe(true);
    expect((await reserveCardBudget(OCT_1)).ok).toBe(true);
    expect(await reserveCardBudget(OCT_1)).toEqual({ ok: false, reason: "full" });
    expect(H.ledger.get("2026-10-01")).toBe(2);
  });

  it("two concurrent reserves with room for one: exactly one passes", async () => {
    H.setting = START_CARD_RESERVE_USD;
    const [a, b] = await Promise.all([reserveCardBudget(OCT_1), reserveCardBudget(OCT_1)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(H.ledger.get("2026-10-01")).toBe(START_CARD_RESERVE_USD);
  });

  it("a ledger error refuses (fail closed), it does not report 'full'", async () => {
    H.fail = true;
    expect(await reserveCardBudget(OCT_1)).toEqual({ ok: false, reason: "error" });
  });

  it("charges the UTC day", () => {
    expect(budgetDay(new Date("2026-10-13T06:59:00Z"))).toBe("2026-10-13");
  });
});

describe("release and settle", () => {
  it("release on failure gives the whole reservation back, so the next card fits", async () => {
    H.setting = 1;
    const r = await reserveCardBudget(OCT_1);
    expect(r.ok).toBe(true);
    expect((await reserveCardBudget(OCT_1)).ok).toBe(false);
    await releaseCardBudget("2026-10-01", START_CARD_RESERVE_USD);
    expect((await reserveCardBudget(OCT_1)).ok).toBe(true);
  });

  it("settle releases the unspent part of a reservation", async () => {
    H.setting = 10;
    await reserveCardBudget(OCT_1);
    await settleCardBudget("2026-10-01", 1, 0.67);
    expect(H.ledger.get("2026-10-01")).toBeCloseTo(0.67, 4);
  });

  it("settle books an overrun that was already spent", async () => {
    H.setting = 10;
    await reserveCardBudget(OCT_1);
    await settleCardBudget("2026-10-01", 1, 1.3);
    expect(H.ledger.get("2026-10-01")).toBeCloseTo(1.3, 4);
  });

  it("release throws on a ledger error (the worker step retries it)", async () => {
    H.fail = true;
    await expect(releaseCardBudget("2026-10-01", 1)).rejects.toThrow(/adjust failed/);
  });
});
