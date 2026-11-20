import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  reserve: { data: "log-1" as unknown, error: null as unknown },
  finalize: { data: "ok" as unknown, error: null as unknown },
  insertResult: { data: { id: "log-r" } as unknown, error: null as unknown },
  calls: [] as { name: string; args: Record<string, unknown>; tid: string }[],
  inserted: [] as Record<string, unknown>[],
  throwOnRpc: false,
  throwOnInsert: false,
}));
const logs = vi.hoisted(() => ({ logEvent: vi.fn() }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
    if (db.throwOnRpc) throw new Error("boom");
    db.calls.push({ name, args, tid });
    return name === "reserve_data_access" ? db.reserve : db.finalize;
  },
  tenantClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        if (db.throwOnInsert) throw new Error("boom");
        db.inserted.push(row);
        return { select: () => ({ single: async () => db.insertResult }) };
      },
    }),
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: logs.logEvent }));

import { reserveAudit, finalizeAudit, writeRefusalAudit, MAX_QUERY_TEXT } from "../audit";
import { AuditUnavailableError, DbSourceChangedError, type GatewayContext } from "../types";

const agent: GatewayContext = { tenant_id: "t1", caller: { kind: "agent", agent_slug: "pm", run_id: "r1", tool_name: "operator_db__codeact" } };
const background: GatewayContext = { tenant_id: "t1", caller: { kind: "background", feature: "Booking metrics" } };
const person: GatewayContext = { tenant_id: "t1", caller: { kind: "person", user_id: "u1", feature: "Contact import" } };
const entry = (ctx: GatewayContext) => ({ ctx, mode: "direct" as const, dialect: "postgres", operation: "read" as const, query_text: "SELECT 1", tables: ["users"] });

beforeEach(() => {
  db.reserve = { data: "log-1", error: null };
  db.finalize = { data: "ok", error: null };
  db.insertResult = { data: { id: "log-r" }, error: null };
  db.calls = [];
  db.inserted = [];
  db.throwOnRpc = false;
  db.throwOnInsert = false;
  logs.logEvent.mockReset();
});

describe("reserveAudit", () => {
  it("returns the id of a pending row scoped to the tenant, carrying the generation fence", async () => {
    expect(await reserveAudit({ ...entry(agent), generation: 4 })).toBe("log-1");
    expect(db.calls[0]).toMatchObject({ name: "reserve_data_access", tid: "t1" });
    expect(db.calls[0]!.args).toMatchObject({ p_generation: 4, p_caller_kind: "agent", p_agent_slug: "pm", p_run_id: "r1", p_tool_name: "operator_db__codeact" });
  });
  it("no generation = no fence (null)", async () => {
    await reserveAudit(entry(agent));
    expect(db.calls[0]!.args.p_generation).toBeNull();
  });
  it("a moved generation (ZD412) is db_source_changed: the read must not run", async () => {
    db.reserve = { data: null, error: { code: "ZD412" } };
    await expect(reserveAudit({ ...entry(agent), generation: 1 })).rejects.toBeInstanceOf(DbSourceChangedError);
  });
  it("throws AuditUnavailableError on an error or a throw", async () => {
    db.reserve = { data: null, error: { message: "down" } };
    await expect(reserveAudit(entry(agent))).rejects.toBeInstanceOf(AuditUnavailableError);
    db.throwOnRpc = true;
    await expect(reserveAudit(entry(agent))).rejects.toBeInstanceOf(AuditUnavailableError);
  });
  it("caps query text and records person user_id + feature", async () => {
    await reserveAudit({ ...entry(person), query_text: "x".repeat(MAX_QUERY_TEXT + 50) });
    expect((db.calls[0]!.args.p_query_text as string).length).toBe(MAX_QUERY_TEXT);
    expect(db.calls[0]!.args).toMatchObject({ p_caller_kind: "person", p_user_id: "u1", p_feature: "Contact import", p_agent_slug: null });
  });
});

describe("finalizeAudit", () => {
  it.each([
    [agent, "allowed", true],
    [agent, "refused", false],
    [background, "allowed", false],
    [person, "allowed", false],
  ] as const)("sent_to_ai %#", async (ctx, result, expected) => {
    await finalizeAudit("log-1", ctx, { result, row_count: 3, ms: 12, generation: 2 });
    expect(db.calls[0]!.args).toMatchObject({ p_id: "log-1", p_result: result, p_sent_to_ai: expected, p_row_count: 3, p_generation: 2 });
  });
  it("must-catch: an allowed result whose finalize fails is NOT released (AuditUnavailableError)", async () => {
    db.finalize = { data: null, error: { message: "nope" } };
    await expect(finalizeAudit("log-1", agent, { result: "allowed", row_count: 1, ms: 1 })).rejects.toBeInstanceOf(AuditUnavailableError);
    db.throwOnRpc = true;
    await expect(finalizeAudit("log-1", agent, { result: "allowed", row_count: 1, ms: 1 })).rejects.toBeInstanceOf(AuditUnavailableError);
  });
  it("must-catch: an allowed result finalized after a transition is discarded (DbSourceChangedError)", async () => {
    db.finalize = { data: "source_changed", error: null };
    await expect(finalizeAudit("log-1", agent, { result: "allowed", row_count: 1, ms: 1, generation: 1 })).rejects.toBeInstanceOf(DbSourceChangedError);
  });
  it("must-catch: a finalize that finds no row does not release", async () => {
    db.finalize = { data: "not_found", error: null };
    await expect(finalizeAudit("log-1", agent, { result: "allowed", row_count: 1, ms: 1 })).rejects.toBeInstanceOf(AuditUnavailableError);
  });
  it("must-not-catch: a failed/refused outcome's write error is logged, never thrown (the read's own error propagates)", async () => {
    db.finalize = { data: null, error: { message: "nope" } };
    await expect(finalizeAudit("log-1", agent, { result: "failed", row_count: 0, ms: 1 })).resolves.toBeUndefined();
    expect(logs.logEvent).toHaveBeenCalled();
  });
});

describe("writeRefusalAudit", () => {
  it("writes one refused row", async () => {
    expect(await writeRefusalAudit({ ...entry(agent), refused_by: "zavi", reason: "users.email is hidden" })).toBe("log-r");
    expect(db.inserted[0]).toMatchObject({ result: "refused", refused_by: "zavi", sent_to_ai: false });
  });
  it("an insert failure returns null without throwing", async () => {
    db.throwOnInsert = true;
    expect(await writeRefusalAudit({ ...entry(agent), refused_by: "zavi", reason: "x" })).toBeNull();
  });
});
