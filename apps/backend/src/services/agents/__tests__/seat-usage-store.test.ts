import { beforeEach, describe, expect, it, vi } from "vitest";

const upserts: Array<Record<string, unknown>> = [];
let usageRows: Array<Record<string, unknown>> = [];
let blob: Record<string, unknown> = {};

vi.mock("@/services/tenant-client", () => ({
  recordSeatUsageRpc: async (a: Record<string, unknown>) => {
    upserts.push({ seat: a.seat, rate_limit_type: a.rateLimitType, status: a.status, utilization: a.utilization });
  },
  globalClient: () => ({
    from: (table: string) => ({
      upsert: async (payload: Record<string, unknown>) => {
        upserts.push(payload);
        return { data: null, error: null };
      },
      select: () =>
        table === "system_config"
          ? { eq: () => ({ maybeSingle: async () => ({ data: { blob }, error: null }) }) }
          : { gt: async () => ({ data: usageRows, error: null }) },
    }),
  }),
}));

import {
  _resetSeatUsageForTest,
  holdSeat,
  orderByRoom,
  recordSeatUsage,
  refreshSeatUsage,
  seatHeadroomRoutingEnabled,
  seatRoom,
} from "../seat-usage-store";
import { _resetTokenRotationForTest, benchSeatForLimit, isTokenCooling, markTokenCooldown, orderAttemptTokens } from "../agent-auth";

const NOW = Date.parse("2026-10-12T14:00:00Z");
const label = (t: string) => `seat_${t}`;

beforeEach(() => {
  upserts.length = 0;
  usageRows = [];
  blob = {};
  _resetSeatUsageForTest();
  _resetTokenRotationForTest();
});

describe("recordSeatUsage", () => {
  it("keeps the latest report per seat and window and writes it", () => {
    recordSeatUsage("seat_a", { status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt: NOW / 1000 + 3600 }, NOW);
    expect(seatRoom("seat_a", NOW)).toBeCloseTo(0.6);
    expect(upserts[0]).toMatchObject({ seat: "seat_a", rate_limit_type: "seven_day", status: "allowed", utilization: 0.4 });
  });

  it("an older report never replaces a newer one", () => {
    recordSeatUsage("seat_a", { status: "rejected", rateLimitType: "five_hour" }, NOW);
    recordSeatUsage("seat_a", { status: "allowed", rateLimitType: "five_hour", utilization: 0.1 }, NOW - 60_000);
    expect(seatRoom("seat_a", NOW)).toBe(0);
  });

  it("an equal-timestamp report keeps the one already stored", () => {
    recordSeatUsage("seat_a", { status: "rejected", rateLimitType: "five_hour" }, NOW);
    recordSeatUsage("seat_a", { status: "allowed", rateLimitType: "five_hour", utilization: 0.1 }, NOW);
    expect(seatRoom("seat_a", NOW)).toBe(0);
  });

  it("ignores a malformed report", () => {
    recordSeatUsage("seat_a", {} as never, NOW);
    expect(upserts).toEqual([]);
  });
});

describe("seatRoom", () => {
  it("the tightest window decides: weekly room does not hide a full 5-hour window", () => {
    recordSeatUsage("seat_a", { status: "allowed", rateLimitType: "seven_day", utilization: 0.2 }, NOW);
    recordSeatUsage("seat_a", { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95 }, NOW);
    expect(seatRoom("seat_a", NOW)).toBeCloseTo(0.05);
  });

  it("no report → the middle; a warning with no number → low; a window that has reset → ignored", () => {
    expect(seatRoom("seat_none", NOW)).toBe(0.5);
    recordSeatUsage("seat_w", { status: "allowed_warning", rateLimitType: "seven_day" }, NOW);
    expect(seatRoom("seat_w", NOW)).toBe(0.2);
    recordSeatUsage("seat_r", { status: "rejected", rateLimitType: "five_hour", resetsAt: NOW / 1000 - 1 }, NOW - 1000);
    expect(seatRoom("seat_r", NOW)).toBe(0.5);
  });

  it("each run in flight on a seat takes a little room, and is given back", () => {
    const release = holdSeat("seat_a");
    holdSeat("seat_a");
    expect(seatRoom("seat_a", NOW)).toBeCloseTo(0.4);
    release();
    release();
    expect(seatRoom("seat_a", NOW)).toBeCloseTo(0.45);
  });
});

describe("orderByRoom", () => {
  it("most room first, ties keep round-robin order, benched seats last", () => {
    recordSeatUsage(label("b"), { status: "allowed", rateLimitType: "seven_day", utilization: 0.1 }, NOW);
    recordSeatUsage(label("c"), { status: "allowed", rateLimitType: "seven_day", utilization: 0.9 }, NOW);
    const benched = (t: string) => t === "d";
    expect(orderByRoom(["a", "b", "c", "d", "e"], benched, label, NOW)).toEqual(["b", "a", "e", "c", "d"]);
  });

  it("eight runs at once do not all land on the emptiest seat", () => {
    recordSeatUsage(label("a"), { status: "allowed", rateLimitType: "seven_day", utilization: 0.3 }, NOW);
    recordSeatUsage(label("b"), { status: "allowed", rateLimitType: "seven_day", utilization: 0.4 }, NOW);
    const firsts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const first = orderByRoom(["a", "b"], () => false, label, NOW)[0];
      firsts.push(first);
      holdSeat(label(first));
    }
    expect(firsts.filter((f) => f === "b").length).toBeGreaterThan(0);
  });
});

describe("the routing switch", () => {
  it("off by default: orderAttemptTokens is round-robin with benched seats last", async () => {
    await refreshSeatUsage();
    expect(seatHeadroomRoutingEnabled()).toBe(false);
    expect(orderAttemptTokens({ pool: ["oat-a", "oat-b", "oat-c"], startOffset: 0 })).toEqual(["oat-a", "oat-b", "oat-c"]);
  });

  it("system_config.blob.seat_headroom_routing = true turns it on", async () => {
    blob = { seat_headroom_routing: true };
    await refreshSeatUsage();
    expect(seatHeadroomRoutingEnabled()).toBe(true);
    const { seatLabelForToken } = await import("../seat-identity");
    recordSeatUsage(seatLabelForToken("oat-a"), { status: "rejected", rateLimitType: "seven_day" });
    expect(orderAttemptTokens({ pool: ["oat-a", "oat-b", "oat-c"], startOffset: 0 })[0]).not.toBe("oat-a");
  });
});

describe("benchSeatForLimit", () => {
  it("a weekly cap benches the seat until its reset, and a later short bench never shortens it", () => {
    benchSeatForLimit("oat-a", "You've hit your weekly limit · resets 4am (UTC)", null, NOW);
    const reset = Date.parse("2026-10-13T04:00:00Z");
    expect(isTokenCooling("oat-a", reset - 60_000)).toBe(true);
    markTokenCooldown("oat-a", NOW, 60_000);
    expect(isTokenCooling("oat-a", reset - 60_000)).toBe(true);
    expect(isTokenCooling("oat-a", reset + 60_000)).toBe(false);
  });
});

describe("in-flight holds", () => {
  it("a hold that is never released stops counting after 30 minutes", () => {
    holdSeat("seat_x", NOW);
    expect(seatRoom("seat_x", NOW + 60_000)).toBeCloseTo(0.45);
    expect(seatRoom("seat_x", NOW + 31 * 60_000)).toBeCloseTo(0.5);
  });
});

