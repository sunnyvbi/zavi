import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rows: Array<{ seat: string; cooling_until: string }> = [];
let upserts: Array<Record<string, unknown>> = [];
let failRead = false;
let failWrite = false;
let writeReturnsError = false;

vi.mock("@/services/tenant-client", () => ({
  benchSeatCooldownRpc: async (seat: string, untilIso: string, reason: string) => {
    if (failWrite) throw new Error("write down");
    if (writeReturnsError) throw new Error("permission denied");
    const prev = rows.find((r) => r.seat === seat);
    if (prev && Date.parse(prev.cooling_until) >= Date.parse(untilIso)) return;
    upserts.push({ seat, cooling_until: untilIso, reason });
  },
  globalClient: () => ({
    from: () => ({
      select: () => ({
        gt: async () =>
          failRead
            ? { data: null, error: { message: "db down" } }
            : { data: rows, error: null },
        eq: (_col: string, seat: string) => ({
          maybeSingle: async () => {
            const hit = rows.find((r) => r.seat === seat);
            return { data: hit ? { cooling_until: hit.cooling_until } : null, error: null };
          },
        }),
      }),
      upsert: async (payload: Record<string, unknown>) => {
        if (failWrite) throw new Error("write down");
        if (writeReturnsError) return { data: null, error: { message: "permission denied" } };
        upserts.push(payload);
        return { data: null, error: null };
      },
    }),
  }),
}));

const settle = () => new Promise((r) => setTimeout(r, 0));

async function freshStore() {
  vi.resetModules();
  return import("../seat-cooldown-store");
}

beforeEach(() => {
  rows.length = 0;
  upserts = [];
  failRead = false;
  failWrite = false;
  writeReturnsError = false;
});
afterEach(() => {
  vi.resetModules();
});

describe("seat-cooldown-store", () => {
  it("publish sets the LOCAL cache synchronously (this replica is instantly correct)", async () => {
    const s = await freshStore();
    const until = Date.now() + 60_000;
    s.publishSeatCooldown({ seat: "seat_aaa", until });
    expect(s.isSeatCoolingShared("seat_aaa")).toBe(true);
  });

  it("a cooldown published by ANOTHER replica is honoured after a refresh", async () => {
    const s = await freshStore();
    expect(s.isSeatCoolingShared("seat_bbb")).toBe(false);
    rows.push({
      seat: "seat_bbb",
      cooling_until: new Date(Date.now() + 60_000).toISOString(),
    });
    await s.refreshSeatCooldowns();
    expect(s.isSeatCoolingShared("seat_bbb")).toBe(true);
  });

  it("an EXPIRED shared row does not bench a seat", async () => {
    const s = await freshStore();
    rows.push({
      seat: "seat_ccc",
      cooling_until: new Date(Date.now() - 1_000).toISOString(),
    });
    await s.refreshSeatCooldowns();
    expect(s.isSeatCoolingShared("seat_ccc")).toBe(false);
  });

  it("refresh does not drop a still-live LOCAL cooldown missing from the read", async () => {
    const s = await freshStore();
    s.publishSeatCooldown({ seat: "seat_local", until: Date.now() + 60_000 });
    await s.refreshSeatCooldowns();
    expect(s.isSeatCoolingShared("seat_local")).toBe(true);
  });

  it("a failed READ keeps the last-known-good cache (fail-open)", async () => {
    const s = await freshStore();
    rows.push({
      seat: "seat_keep",
      cooling_until: new Date(Date.now() + 60_000).toISOString(),
    });
    await s.refreshSeatCooldowns();
    failRead = true;
    await s.refreshSeatCooldowns();
    expect(s.isSeatCoolingShared("seat_keep")).toBe(true);
  });

  it("a failed WRITE never throws and still benches locally", async () => {
    const s = await freshStore();
    failWrite = true;
    expect(() =>
      s.publishSeatCooldown({ seat: "seat_ddd", until: Date.now() + 60_000 }),
    ).not.toThrow();
    expect(s.isSeatCoolingShared("seat_ddd")).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
  });

  it("publish never widens a cooldown backwards", async () => {
    const s = await freshStore();
    const far = Date.now() + 600_000;
    s.publishSeatCooldown({ seat: "seat_eee", until: far });
    s.publishSeatCooldown({ seat: "seat_eee", until: Date.now() + 1_000 });
    const snap = s.coolingSeatsSnapshot();
    expect(Date.parse(snap.find((x) => x.seat === "seat_eee")!.cooling_until)).toBe(far);
  });

  it("the token itself is never sent to the DB — only the hashed seat", async () => {
    const s = await freshStore();
    s.publishSeatCooldown({ seat: "seat_fff", until: Date.now() + 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.stringify(upserts)).not.toContain("oat-");
    expect(upserts[0]).toMatchObject({ seat: "seat_fff" });
  });

  it("a shorter bench never overwrites a longer one another process wrote", async () => {
    const s = await freshStore();
    const weekly = Date.now() + 3 * 24 * 3_600_000;
    rows.push({ seat: "seat_ddd", cooling_until: new Date(weekly).toISOString() });
    s.publishSeatCooldown({ seat: "seat_ddd", until: Date.now() + 20 * 60_000 });
    await settle();
    await settle();
    expect(upserts).toEqual([]);
  });

  it("a write the database refuses is logged, not swallowed", async () => {
    const s = await freshStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeReturnsError = true;
    s.publishSeatCooldown({ seat: "seat_eee", until: Date.now() + 60_000 });
    await settle();
    await settle();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("permission denied"))).toBe(true);
    warn.mockRestore();
  });

  it("refresh keeps a longer local bench over a shorter shared row", async () => {
    const s = await freshStore();
    const long = Date.now() + 5 * 3_600_000;
    s._setSeatCooldownsForTest([["seat_fff", long]]);
    rows.push({ seat: "seat_fff", cooling_until: new Date(Date.now() + 60_000).toISOString() });
    await s.refreshSeatCooldowns();
    expect(s.coolingSeatsSnapshot().find((x) => x.seat === "seat_fff")?.cooling_until).toBe(new Date(long).toISOString());
  });
});
