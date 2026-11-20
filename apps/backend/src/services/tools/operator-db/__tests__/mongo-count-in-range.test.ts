
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  countDocuments: vi.fn<unknown[], Promise<number>>(),
  findOne: vi.fn(),
  connectError: null as Error | null,
}));

vi.mock("mongodb", () => {
  class ObjectId {
    static isValid() {
      return false;
    }
  }
  class MongoClient {
    async connect() {
      if (mocks.connectError) throw mocks.connectError;
    }
    async close() {}
    on() {}
    db() {
      return {
        collection: (name: string) => ({
          countDocuments: (...a: unknown[]) => mocks.countDocuments(name, ...a),
          findOne: (...a: unknown[]) => mocks.findOne(name, ...a),
        }),
      };
    }
  }
  return { MongoClient, ObjectId };
});

import { mongoDriver } from "../drivers/mongo";
import { attachMongoSession } from "./helpers/attach-test-session";
import type { SchemaMap } from "../types";

async function makeCfg(over: Record<string, unknown> = {}): Promise<SchemaMap> {
  const cfg = {
    users: { table: "users", id_field: "_id" },
    bookings: { table: "trips", id_field: "_id", created_at_field: "bookedAt" },
    ...over,
  } as unknown as SchemaMap;
  return attachMongoSession(cfg, "mongodb://probe.example/upcar");
}

const RANGE = { since: "2026-06-22T00:00:00.000Z", until: "2026-06-29T00:00:00.000Z" };

beforeEach(() => {
  mocks.countDocuments.mockReset();
  mocks.findOne.mockReset().mockImplementation(async (_n: string, filter: Record<string, unknown>) => ({ [Object.keys(filter)[0]]: new Date() }));
  mocks.connectError = null;
});

describe("mongo · query_new_users_in_range", () => {
  it("counts users in the half-open range with the createdAt fallback field", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(42);
    const res = await mongoDriver().query_new_users_in_range!(RANGE, await makeCfg());
    expect(res).toEqual({
      ok: true,
      data: { available: true, since: RANGE.since, until: RANGE.until, count: 42 },
    });
    const [, filter] = mocks.countDocuments.mock.calls[1] as [
      string,
      { createdAt: { $gte: Date; $lt: Date } },
    ];
    expect(filter.createdAt.$gte.toISOString()).toBe(RANGE.since);
    expect(filter.createdAt.$lt.toISOString()).toBe(RANGE.until);
  });

  it("a string-typed created-at → not_available(date_field_is_string), never a false 0 (B10)", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.findOne.mockResolvedValueOnce({ createdAt: "2026-06-23" });
    const res = await mongoDriver().query_new_users_in_range!(RANGE, await makeCfg());
    expect(res.ok && res.data).toMatchObject({ available: false, detail: "date_field_is_string" });
    expect(mocks.countDocuments).toHaveBeenCalledTimes(1);
  });

  it("probe zero (field absent) → not_available, NEVER a false zero", async () => {
    mocks.countDocuments.mockResolvedValueOnce(0);
    const res = await mongoDriver().query_new_users_in_range!(RANGE, await makeCfg());
    expect(res.ok && res.data).toMatchObject({ available: false, reason: "not_available" });
    expect(mocks.countDocuments).toHaveBeenCalledTimes(1);
  });

  it("invalid range (since >= until) refuses without touching the DB", async () => {
    const res = await mongoDriver().query_new_users_in_range!(
      { since: RANGE.until, until: RANGE.since },
      await makeCfg(),
    );
    expect(res.ok && res.data).toMatchObject({ available: false });
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it("driver error → not_available, never throws", async () => {
    mocks.countDocuments.mockRejectedValue(new Error("boom"));
    const res = await mongoDriver().query_new_users_in_range!(RANGE, await makeCfg());
    expect(res.ok && res.data).toMatchObject({ available: false });
  });
});

describe("mongo · query_new_bookings_in_range", () => {
  it("uses the bookings map's explicit created_at_field", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(7);
    const res = await mongoDriver().query_new_bookings_in_range!(RANGE, await makeCfg());
    expect(res.ok && res.data).toMatchObject({ available: true, count: 7 });
    const [coll, filter] = mocks.countDocuments.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    expect(coll).toBe("trips");
    expect(Object.keys(filter)).toEqual(["bookedAt"]);
  });

  it("missing bookings map → not_available", async () => {
    const res = await mongoDriver().query_new_bookings_in_range!(
      RANGE,
      await makeCfg({ bookings: undefined }),
    );
    expect(res.ok && res.data).toMatchObject({ available: false });
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });
});

describe("mongo · query_new_users_in_range with an equality match (live stunt new hosts)", () => {
  it("adds the match to the COUNT but not the field probe", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(7);
    const res = await mongoDriver().query_new_users_in_range!({ ...RANGE, match: { hostStatus: true } }, await makeCfg());
    expect(res).toMatchObject({ ok: true, data: { available: true, count: 7 } });
    const [, probe] = mocks.countDocuments.mock.calls[0] as [string, Record<string, unknown>];
    const [, count] = mocks.countDocuments.mock.calls[1] as [string, Record<string, unknown>];
    expect(probe).not.toHaveProperty("hostStatus");
    expect(count).toMatchObject({ hostStatus: true });
  });
  it("zero matching users is a real 0, not not_available", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await mongoDriver().query_new_users_in_range!({ ...RANGE, match: { hostStatus: true } }, await makeCfg());
    expect(res).toMatchObject({ ok: true, data: { available: true, count: 0 } });
  });
  it("refuses operator or nested matches without querying", async () => {
    const bad = [{ $where: "1" }, { hostStatus: { $ne: false } }, { "a.b": 1 }] as unknown as Record<string, boolean>[];
    for (const match of bad) {
      const res = await mongoDriver().query_new_users_in_range!({ ...RANGE, match }, await makeCfg());
      expect(res).toMatchObject({ ok: true, data: { available: false } });
    }
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });
});
