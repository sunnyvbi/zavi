import { describe, it, expect, vi, beforeEach } from "vitest";

const openMongoSession = vi.fn();
vi.mock("../direct/mongo", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  openMongoSession: (...a: unknown[]) => openMongoSession(...a),
}));
const openSqlSession = vi.fn();
vi.mock("../direct/sql", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  openSqlSession: (...a: unknown[]) => openSqlSession(...a),
}));
const raiseOutage = vi.fn(async (..._a: unknown[]) => undefined);
const clearOutageIfOpen = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../direct/outage-card", () => ({
  raiseOutage: (...a: unknown[]) => raiseOutage(...a),
  clearOutageIfOpen: (...a: unknown[]) => clearOutageIfOpen(...a),
}));
vi.mock("../direct/outage-facts", () => ({
  lastSuccessfulReadAt: vi.fn(async () => "2026-10-17T21:09:10Z"),
  egressIps: vi.fn(async () => ["203.0.113.10"]),
  within: <T,>(p: Promise<T>) => p,
}));

import { __openDirectForTest, __resetOpenDirectState } from "../index";
import { __resetReachability } from "../direct/reachability";
import { DatabaseUnreachableError } from "../types";
import * as facts from "../direct/outage-facts";

const access = { tenant_id: "t1", dialect: "mongodb", connectionString: "mongodb+srv://x/db", generation: 3 } as never;

function selectionError(message = "Server selection timed out after 8000 ms"): Error {
  const e = new Error(message);
  e.name = "MongoServerSelectionError";
  return e;
}

describe("openDirect on an unreachable database", () => {
  beforeEach(() => {
    __resetReachability();
    __resetOpenDirectState();
    openMongoSession.mockReset();
    raiseOutage.mockClear();
    clearOutageIfOpen.mockClear();
    vi.mocked(facts.lastSuccessfulReadAt).mockClear();
  });

  it("turns the connection failure into DatabaseUnreachableError and raises the card", async () => {
    openMongoSession.mockRejectedValueOnce(selectionError());
    await expect(__openDirectForTest(access)).rejects.toBeInstanceOf(DatabaseUnreachableError);
    expect(raiseOutage).toHaveBeenCalledTimes(1);
    expect(raiseOutage.mock.calls[0]?.[0]).toBe("t1");
  });

  it("fails the next read at once without dialing", async () => {
    openMongoSession.mockRejectedValueOnce(selectionError());
    await expect(__openDirectForTest(access)).rejects.toBeInstanceOf(DatabaseUnreachableError);
    await expect(__openDirectForTest(access)).rejects.toThrow(/last read it successfully on Oct 17/);
    expect(openMongoSession).toHaveBeenCalledTimes(1);
  });

  it("a memoized failure skips the fact lookups and the card", async () => {
    openMongoSession.mockRejectedValueOnce(selectionError());
    await expect(__openDirectForTest(access)).rejects.toBeInstanceOf(DatabaseUnreachableError);
    vi.mocked(facts.lastSuccessfulReadAt).mockClear();
    raiseOutage.mockClear();
    await expect(__openDirectForTest(access)).rejects.toBeInstanceOf(DatabaseUnreachableError);
    expect(facts.lastSuccessfulReadAt).not.toHaveBeenCalled();
    expect(raiseOutage).not.toHaveBeenCalled();
  });

  it("passes a query-level error through untouched and raises nothing", async () => {
    const e = new Error("unknown top level operator: $nope");
    e.name = "MongoServerError";
    openMongoSession.mockRejectedValueOnce(e);
    await expect(__openDirectForTest(access)).rejects.toBe(e);
    expect(raiseOutage).not.toHaveBeenCalled();
  });

  it("a TLS refusal gets the existing TLS settings message, not an outage", async () => {
    openMongoSession.mockRejectedValueOnce(selectionError("SSL routines: wrong version number"));
    const tlsAccess = { ...(access as object), connectionString: "mongodb://host:27017/db?tls=true" } as never;
    await expect(__openDirectForTest(tlsAccess)).rejects.toMatchObject({ code: "operator_db_tls_refused" });
    expect(raiseOutage).not.toHaveBeenCalled();
  });

  it("a Postgres server without TLS gets the TLS settings message (no network code on that error)", async () => {
    openSqlSession.mockRejectedValueOnce(new Error("The server does not support SSL connections"));
    const pgAccess = { tenant_id: "t1", dialect: "postgres", connectionString: "postgres://u@h:5432/db", generation: 3 } as never;
    await expect(__openDirectForTest(pgAccess)).rejects.toMatchObject({ code: "operator_db_tls_refused" });
    expect(raiseOutage).not.toHaveBeenCalled();
  });

  it("a Mongo socket reset is an outage, not a TLS problem", async () => {
    openMongoSession.mockRejectedValueOnce(selectionError("connection 1 to host:27017 closed: read ECONNRESET"));
    const tlsAccess = { ...(access as object), connectionString: "mongodb://host:27017/db?tls=true" } as never;
    await expect(__openDirectForTest(tlsAccess)).rejects.toBeInstanceOf(DatabaseUnreachableError);
    expect(raiseOutage).toHaveBeenCalledTimes(1);
  });

  it("the process that saw the failure clears the card on its next success", async () => {
    openMongoSession.mockRejectedValueOnce(selectionError());
    await expect(__openDirectForTest(access)).rejects.toBeInstanceOf(DatabaseUnreachableError);
    __resetReachability();
    openMongoSession.mockResolvedValueOnce({ close: async () => undefined });
    await __openDirectForTest(access);
    expect(clearOutageIfOpen).toHaveBeenCalledWith("t1", { sawFailure: true });
  });

  it("a successful connect checks for an open outage", async () => {
    openMongoSession.mockResolvedValueOnce({ close: async () => undefined });
    await __openDirectForTest(access);
    expect(clearOutageIfOpen).toHaveBeenCalledWith("t1", { sawFailure: false });
  });
});
