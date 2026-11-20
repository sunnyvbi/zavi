
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

async function makeCfg(users?: Record<string, unknown>): Promise<SchemaMap> {
  const cfg = {
    users: users ?? { table: "users", id_field: "_id" },
  } as unknown as SchemaMap;
  return attachMongoSession(cfg, "mongodb://probe.example/upcar");
}

const NOT_AVAILABLE = {
  ok: true,
  data: { available: false, reason: "not_available", window_days: 7, count: 0 },
};

beforeEach(() => {
  mocks.countDocuments.mockReset();
  mocks.findOne.mockReset().mockImplementation(async (_n: string, filter: Record<string, unknown>) => ({ [Object.keys(filter)[0]]: new Date() }));
  mocks.connectError = null;
});

describe("mongo · query_new_users_in_window", () => {
  it("counts users created within the rolling window from cfg.users.table", async () => {
    mocks.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(37);
    const before = Date.now();
    const res = await mongoDriver().query_new_users_in_window(
      { window_days: 7 },
      await makeCfg(),
    );
    expect(res).toEqual({
      ok: true,
      data: { available: true, window_days: 7, count: 37 },
    });

    expect(mocks.countDocuments).toHaveBeenCalledTimes(2);
    const [probeColl, probeFilter, probeOpts] = mocks.countDocuments.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(probeColl).toBe("users");
    expect(probeFilter).toEqual({ createdAt: { $exists: true, $ne: null } });
    expect(probeOpts).toMatchObject({ limit: 1 });
    const [countColl, countFilter] = mocks.countDocuments.mock.calls[1] as [
      string,
      { createdAt: { $gte: Date } },
    ];
    expect(countColl).toBe("users");
    const gte = countFilter.createdAt.$gte;
    expect(gte).toBeInstanceOf(Date);
    const expectedMs = before - 7 * 86400 * 1000;
    expect(Math.abs(gte.getTime() - expectedMs)).toBeLessThan(60_000);
  });

  it("explicit cfg.users.created_at_field wins over the 'createdAt' fallback", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(4);
    const res = await mongoDriver().query_new_users_in_window(
      { window_days: 7 },
      await makeCfg({ table: "members", id_field: "_id", created_at_field: "joined_at" }),
    );
    expect(res.data).toMatchObject({ available: true, count: 4 });
    expect(mocks.countDocuments.mock.calls[0][0]).toBe("members");
    expect(mocks.countDocuments.mock.calls[0][1]).toEqual({
      joined_at: { $exists: true, $ne: null },
    });
    expect(Object.keys(mocks.countDocuments.mock.calls[1][1] as object)).toEqual([
      "joined_at",
    ]);
  });

  it("FALSE-ZERO GUARD: collection missing / field absent (probe 0) → not_available, never a zero count", async () => {
    mocks.countDocuments.mockResolvedValueOnce(0);
    const res = await mongoDriver().query_new_users_in_window(
      { window_days: 7 },
      await makeCfg(),
    );
    expect(res).toEqual(NOT_AVAILABLE);
    expect(mocks.countDocuments).toHaveBeenCalledTimes(1);
  });

  it("no users map → not_available without touching the DB", async () => {
    const res = await mongoDriver().query_new_users_in_window({ window_days: 7 }, await makeCfg({} as Record<string, unknown>));
    expect(res.data).toMatchObject({ available: false, reason: "not_available" });
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it("fail-safe: a driver/connection error degrades to not_available (never crash)", async () => {
    mocks.countDocuments.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await mongoDriver().query_new_users_in_window(
      { window_days: 7 },
      await makeCfg(),
    );
    expect(res).toEqual(NOT_AVAILABLE);
  });

  it("a created-at field stored as a STRING → not_available with the reason, never a false 0 (B10)", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.findOne.mockResolvedValueOnce({ createdAt: "2026-09-01T10:00:00.000Z" });
    const res = await mongoDriver().query_new_users_in_window({ window_days: 7 }, await makeCfg());
    expect(res).toEqual({
      ok: true,
      data: { available: false, reason: "not_available", detail: "date_field_is_string", window_days: 7, count: 0 },
    });
    expect(mocks.countDocuments).toHaveBeenCalledTimes(1);
  });

  it("an epoch-number created-at is not a date either", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1);
    mocks.findOne.mockResolvedValueOnce({ createdAt: 1790000000 });
    const res = await mongoDriver().query_new_users_in_window({ window_days: 7 }, await makeCfg());
    expect(res.ok && res.data).toMatchObject({ available: false, detail: "date_field_not_a_date" });
  });

  it("an honest zero from a verified field is still a real measurement", async () => {
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await mongoDriver().query_new_users_in_window(
      { window_days: 7 },
      await makeCfg(),
    );
    expect(res).toEqual({
      ok: true,
      data: { available: true, window_days: 7, count: 0 },
    });
  });
});
