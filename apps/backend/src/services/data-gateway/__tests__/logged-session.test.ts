import { describe, it, expect, vi, beforeEach } from "vitest";
import { effectivePolicy, type CatalogLike } from "@zavi/shared/db-guard";

const audit = vi.hoisted(() => ({
  reserve: vi.fn(),
  finalize: vi.fn(),
  refusal: vi.fn(),
}));
vi.mock("../audit", () => ({
  reserveAudit: audit.reserve,
  finalizeAudit: audit.finalize,
  writeRefusalAudit: audit.refusal,
}));

import { loggedSession } from "../logged-session";
import { fakeSession } from "./fake-session";
import { AuditUnavailableError, GatewayRefusal, type GatewayContext } from "../types";
import type { DbAccess } from "../resolve";
import { collectAccessNotes } from "../note-collector";
import { peekRunNotes, _resetRunNotes } from "../run-reads";

const catalog: CatalogLike = {
  tables: [
    { name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "role" }] },
    { name: "bookings", columns: [{ name: "id" }, { name: "city" }] },
  ],
};
const access = (hidden: string[], dialect: DbAccess["dialect"] = "postgres"): DbAccess =>
  ({
    tenant_id: "t1",
    mode: "direct",
    dialect,
    policy: effectivePolicy({ auto_hide: false, hidden_fields: hidden, unhidden_fields: [], disabled_tables: [] }, catalog, dialect),
  }) as unknown as DbAccess;
const ctx: GatewayContext = { tenant_id: "t1", caller: { kind: "agent", agent_slug: "pm", run_id: "run-1", tool_name: "operator_db__codeact" } };

beforeEach(() => {
  audit.reserve.mockReset().mockResolvedValue("log-1");
  audit.finalize.mockReset().mockResolvedValue(undefined);
  audit.refusal.mockReset().mockResolvedValue("log-r");
  _resetRunNotes();
});

describe("logged session must-catch", () => {
  it("reserve fails -> inner never called, caller gets audit_unavailable", async () => {
    audit.reserve.mockRejectedValue(new AuditUnavailableError());
    const { session, calls } = fakeSession({ dialect: "postgres", rows: [{ id: 1 }] });
    await expect(loggedSession(session, access([]), ctx).query("SELECT id FROM bookings")).rejects.toMatchObject({ code: "audit_unavailable" });
    expect(calls.sql).toHaveLength(0);
  });
  it("hidden users.email: SELECT * reaches inner through the projection and the output has no email", async () => {
    const { session, calls } = fakeSession({ dialect: "postgres", rows: [{ id: 1, email: "a@b.c", role: "x" }] });
    const r = await loggedSession(session, access(["users.email"]), ctx).query("SELECT * FROM users");
    expect(calls.sql[0]!.text).toBe('SELECT * FROM (SELECT "id", "role" FROM ONLY "public"."users") AS "users"');
    expect(r.rows).toEqual([{ id: 1, role: "x" }]);
    expect(audit.finalize).toHaveBeenCalledWith("log-1", ctx, expect.objectContaining({ result: "allowed", row_count: 1 }));
  });
  it("SELECT email FROM users -> refused, inner never called, one refused row, run noted", async () => {
    const { session, calls } = fakeSession({ dialect: "postgres", rows: [] });
    const p = loggedSession(session, access(["users.email"]), ctx).query("SELECT email FROM users");
    await expect(p).rejects.toBeInstanceOf(GatewayRefusal);
    await expect(p).rejects.toMatchObject({ code: "data_access_refused", rule: "settings" });
    expect(calls.sql).toHaveLength(0);
    expect(audit.refusal).toHaveBeenCalledTimes(1);
    expect(audit.reserve).not.toHaveBeenCalled();
    expect(peekRunNotes("run-1")[0]).toMatchObject({ kind: "refused", refused_by: "zavi" });
  });
  it("a write is refused before any audit reservation", async () => {
    const { session, calls } = fakeSession({ dialect: "postgres" });
    await expect(loggedSession(session, access([]), ctx).query("DELETE FROM users")).rejects.toBeInstanceOf(GatewayRefusal);
    expect(calls.sql).toHaveLength(0);
  });
  it("Mongo find gets {email:0} and the output is stripped", async () => {
    const { session, calls } = fakeSession({ dialect: "mongodb", docs: [{ _id: 1, email: "a@b.c", role: "x" }] });
    const out = await loggedSession(session, access(["users.email"], "mongodb"), ctx).mongo().find("users", {});
    expect(calls.mongo[0]!.args[2]).toMatchObject({ projection: { email: 0 } });
    expect(out).toEqual([{ _id: 1, role: "x" }]);
  });
  it("Mongo listCollections returns only readable collections", async () => {
    const { session } = fakeSession({ dialect: "mongodb", docs: [{ name: "users" }, { name: "secrets" }] });
    const out = await loggedSession(session, access([], "mongodb"), ctx).mongo().listCollections();
    expect(out.map((c) => c.name)).toEqual(["users"]);
  });
  it("planner row estimate: allowed tables only, schema-qualified, audit row reserved first", async () => {
    const { session } = fakeSession({ dialect: "postgres" });
    const seen: string[][] = [];
    session.largestTableRows = async (names) => {
      seen.push(names);
      return 42;
    };
    const s = loggedSession(session, access([]), ctx);
    expect(await s.largestTableRows(["bookings", "secret_table", "public.users"])).toBe(42);
    expect(seen).toEqual([['public."bookings"', 'public."users"']]);
    expect(audit.reserve).toHaveBeenCalledWith(expect.objectContaining({ tables: ["bookings", "users"] }));
    audit.reserve.mockRejectedValue(new AuditUnavailableError());
    seen.length = 0;
    expect(await s.largestTableRows(["bookings"])).toBeNull();
    expect(seen).toEqual([]);
  });
  it("a driver error finalizes failed with the error class only, and rethrows", async () => {
    const { session } = fakeSession({ dialect: "postgres", fail: Object.assign(new Error("column email@x does not exist"), { code: "42703" }) });
    await expect(loggedSession(session, access([]), ctx).query("SELECT id FROM bookings")).rejects.toThrow();
    expect(audit.finalize).toHaveBeenCalledWith("log-1", ctx, expect.objectContaining({ result: "failed", reason: "Error (42703)" }));
  });
});

describe("logged session must-not-catch", () => {
  it("empty-policy read on an allowed table runs through the projection with exactly one audit row", async () => {
    const { session, calls } = fakeSession({ dialect: "postgres", rows: [{ city: "LA" }] });
    const { notes } = await collectAccessNotes(() => loggedSession(session, access([]), ctx).query("SELECT city FROM bookings"));
    expect(calls.sql[0]!.text).toBe('SELECT city FROM (SELECT "id", "city" FROM ONLY "public"."bookings") AS "bookings"');
    expect(audit.reserve).toHaveBeenCalledTimes(1);
    expect(audit.finalize).toHaveBeenCalledTimes(1);
    expect(notes).toEqual([{ log_id: "log-1", mode: "direct", tables: ["bookings"], rows: 1, result: "allowed" }]);
  });
});

describe("generation fence and audit-before-release (final review findings 1 and 4)", () => {
  const fenced = { ...access([]), generation: 6 } as DbAccess;
  it("the reservation and the allowed finalize carry the generation the read was resolved under", async () => {
    const { session } = fakeSession({ dialect: "postgres", rows: [{ id: 1 }] });
    await loggedSession(session, fenced, ctx).query("SELECT id FROM bookings");
    expect(audit.reserve.mock.calls[0]![0]).toMatchObject({ generation: 6 });
    expect(audit.finalize).toHaveBeenCalledWith("log-1", ctx, expect.objectContaining({ result: "allowed", generation: 6 }));
  });
  it("must-catch: a source change found at reservation -> the read never runs", async () => {
    const { DbSourceChangedError } = await import("../types");
    audit.reserve.mockRejectedValue(new DbSourceChangedError());
    const { session, calls } = fakeSession({ dialect: "postgres", rows: [{ id: 1 }] });
    await expect(loggedSession(session, fenced, ctx).query("SELECT id FROM bookings")).rejects.toMatchObject({ code: "db_source_changed" });
    expect(calls.sql).toHaveLength(0);
  });
  it("must-catch: an allowed finalize that fails (audit or source changed) drops the rows, and is not re-finalized as failed", async () => {
    const { DbSourceChangedError } = await import("../types");
    for (const err of [new AuditUnavailableError(), new DbSourceChangedError()]) {
      audit.finalize.mockReset().mockImplementation(async (_id: string, _c: unknown, f: { result: string }) => {
        if (f.result === "allowed") throw err;
      });
      const { session } = fakeSession({ dialect: "postgres", rows: [{ id: 1, secret_value: "x" }] });
      await expect(loggedSession(session, fenced, ctx).query("SELECT id FROM bookings")).rejects.toBe(err);
      expect(audit.finalize).toHaveBeenCalledTimes(1);
    }
  });
});

describe("JSON in SQL results through the logged session", () => {
  it("a visible JSON column's sensitive keys never reach the caller", async () => {
    const cat: CatalogLike = { tables: [{ name: "events", columns: [{ name: "id" }, { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["plan"] }] }] };
    const a = { tenant_id: "t1", mode: "direct", dialect: "postgres", generation: 1, policy: effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, cat, "postgres") } as unknown as DbAccess;
    const { session } = fakeSession({ dialect: "postgres", rows: [{ id: 1, payload: { plan: "pro", email: "a@b.c" } }] });
    const r = await loggedSession(session, a, ctx).query("SELECT id, payload FROM events");
    expect(r.rows).toEqual([{ id: 1, payload: { plan: "pro" } }]);
  });
});
