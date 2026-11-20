
import { describe, it, expect, vi } from "vitest";
import { budgetMatches, readBackBudget, readbackTopic } from "../budget-readback";

const base = { tenant_id: "t1", platform: "meta" as const, object_id: "551", label: 'Ad set "Weekend loaves"', minor_per_major: 100, currency: "USD" };
const deps = () => ({ ask: vi.fn(async (_t: string, _topic: string, _ask: string) => true), log: vi.fn() });

describe("budget read-back", () => {
  it("must catch (bakery): the account holds a different budget than Zavi set: one question, deduped by object", async () => {
    const d = deps();
    const r = await readBackBudget({ ...base, expected_minor: 12000, read: async () => 10000 }, d);
    expect(r).toBe("mismatch");
    expect(d.ask).toHaveBeenCalledTimes(1);
    expect(d.ask.mock.calls[0]![1]).toBe(readbackTopic("meta", "551"));
    expect(d.ask.mock.calls[0]![2]).toContain("120.00 USD/day");
    expect(d.ask.mock.calls[0]![2]).toContain("100.00 USD/day");
  });

  it("must not catch (SaaS Google): a match, or a one-cent rounding difference", async () => {
    const d = deps();
    expect(await readBackBudget({ ...base, platform: "google", object_id: "9001", expected_minor: 4500, read: async () => 4500 }, d)).toBe("match");
    expect(await readBackBudget({ ...base, platform: "google", object_id: "9001", expected_minor: 4500, read: async () => 4501 }, d)).toBe("match");
    expect(d.ask).not.toHaveBeenCalled();
    expect(budgetMatches(4500, 4502)).toBe(false);
  });

  it("an unreadable or failing read-back, or a failing question, never throws and asks nothing on a failed read", async () => {
    const d = deps();
    expect(await readBackBudget({ ...base, expected_minor: 12000, read: async () => null }, d)).toBe("unread");
    expect(await readBackBudget({ ...base, expected_minor: 12000, read: async () => Promise.reject(new Error("Graph 500")) }, d)).toBe("unread");
    expect(d.ask).not.toHaveBeenCalled();
    const failing = { ask: vi.fn(async () => Promise.reject(new Error("db"))), log: vi.fn() };
    expect(await readBackBudget({ ...base, expected_minor: 12000, read: async () => 9000 }, failing)).toBe("mismatch");
  });
});
