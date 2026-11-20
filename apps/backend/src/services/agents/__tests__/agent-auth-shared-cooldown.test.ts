import { describe, it, expect, beforeEach, vi } from "vitest";

const shared = new Map<string, number>();
const published: Array<{ seat: string; until: number }> = [];

vi.mock("../seat-cooldown-store", () => ({
  isSeatCoolingShared: (seat: string, now: number = Date.now()) => {
    const u = shared.get(seat);
    return u != null && u > now;
  },
  publishSeatCooldown: (a: { seat: string; until: number }) => {
    published.push(a);
    shared.set(a.seat, a.until);
  },
}));

import {
  isTokenCooling,
  markTokenCooldown,
  orderAttemptTokens,
  _resetTokenRotationForTest,
} from "../agent-auth";
import { seatLabelForToken } from "../seat-identity";

beforeEach(() => {
  shared.clear();
  published.length = 0;
  _resetTokenRotationForTest();
});

describe("agent-auth × fleet-shared cooldown", () => {
  it("honours a cooldown published by another replica", () => {
    const token = "oat-remote";
    expect(isTokenCooling(token)).toBe(false);
    shared.set(seatLabelForToken(token), Date.now() + 60_000);
    expect(isTokenCooling(token)).toBe(true);
  });

  it("markTokenCooldown publishes the HASHED seat, never the token", () => {
    markTokenCooldown("oat-secret", Date.now(), 60_000);
    expect(published).toHaveLength(1);
    expect(published[0].seat).toBe(seatLabelForToken("oat-secret"));
    expect(published[0].seat).not.toContain("oat-secret");
  });

  it("a remotely-benched seat is ordered last", () => {
    const pool = ["oat-1", "oat-2", "oat-3"];
    shared.set(seatLabelForToken("oat-1"), Date.now() + 60_000);
    expect(orderAttemptTokens({ pool, startOffset: 0 })).toEqual([
      "oat-2",
      "oat-3",
      "oat-1",
    ]);
  });

  it("all seats cooling → order preserved, nothing dropped", () => {
    const pool = ["oat-1", "oat-2"];
    for (const t of pool) shared.set(seatLabelForToken(t), Date.now() + 60_000);
    expect(orderAttemptTokens({ pool, startOffset: 0 }).sort()).toEqual(pool.sort());
  });
});
