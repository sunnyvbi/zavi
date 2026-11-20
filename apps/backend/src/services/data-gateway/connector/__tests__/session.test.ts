import { describe, it, expect, vi, beforeEach } from "vitest";
import { BSON } from "mongodb";

const st = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  catalog: null as Record<string, unknown> | null,
  connector: null as Record<string, unknown> | null,
  getSecret: vi.fn(),
  rpc: vi.fn(),
  reserve: vi.fn(),
  finalize: vi.fn(),
  refusal: vi.fn(),
  sent: [] as unknown[],
  wakes: [] as string[],
  acks: [] as unknown[],
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => {
        const row = table === "db_connectors" ? st.connector : st.config;
        const q = { maybeSingle: async () => ({ data: row, error: null }), is: () => q };
        return q;
      },
    }),
  }),
  tenantRpc: (...a: unknown[]) => st.rpc(...a),
}));
vi.mock("@/services/tools/operator-db/catalog", () => ({
  getCatalog: async () => st.catalog,
  hintsToSchemaMapShape: () => ({}),
}));
vi.mock("@/services/tools/operator-db/mapping", () => ({
  getConfirmedMapping: async () => null,
  applyConfirmedMap: (m: unknown) => m,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: st.getSecret }));
vi.mock("../../audit", () => ({
  reserveAudit: (...a: unknown[]) => st.reserve(...a),
  finalizeAudit: (...a: unknown[]) => st.finalize(...a),
  writeRefusalAudit: (...a: unknown[]) => st.refusal(...a),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: vi.fn(async (...a: unknown[]) => void st.sent.push(a)) }));
vi.mock("../wakeup", () => ({ publishWake: async (t: string) => void st.wakes.push(t), publishRevoke: async () => undefined }));

import { withReadSession, GatewayRefusal, ConnectorOfflineError } from "../../index";
import { peekRunNotes, _resetRunNotes } from "../../run-reads";
import { collectAccessNotes } from "../../note-collector";
import type { GatewayContext } from "../../types";

const TENANT = "tenant-A";
const agent: GatewayContext = { tenant_id: TENANT, caller: { kind: "agent", agent_slug: "pm", run_id: "run-1", tool_name: "operator_db__codeact" } };
const background: GatewayContext = { tenant_id: TENANT, caller: { kind: "background", feature: "Booking metrics" } };

function queue(reply: { status: string; result?: unknown; reason?: string | null } | "never") {
  const ops: unknown[] = [];
  let offlineClaims = 0;
  st.rpc.mockImplementation(async (tid: string, name: string, args: Record<string, unknown>) => {
    expect(tid).toBe(TENANT);
    if (name === "enqueue_db_connector_request") {
      ops.push(args.p_op);
      return { data: `req-${ops.length}`, error: null };
    }
    if (name === "take_db_connector_result") return { data: reply === "never" ? [] : [reply], error: null };
    if (name === "cancel_db_connector_request") return { data: null, error: null };
    if (name === "claim_db_connector_offline_notice") {
      offlineClaims += 1;
      return { data: [{ notice_id: "notice-1", should_send: offlineClaims === 1, machine_name: "mac-1", last_seen_at: new Date(Date.now() - 7_200_000).toISOString() }], error: null };
    }
    if (name === "ack_db_connector_offline_notice") {
      st.acks.push(args);
      return { data: null, error: null };
    }
    if (name === "tenant_admin_emails") return { data: ["owner@x.co", "admin@x.co"], error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
  return ops;
}

const rows = (columns: string[], data: unknown[][], extra: Record<string, unknown> = {}) => ({
  status: "done",
  result: { status: "done", data: { kind: "rows", columns, rows: data, truncated: false, removed_columns: [], rule: "rows_without_blocked_columns", ...extra } },
});

beforeEach(() => {
  _resetRunNotes();
  st.sent = [];
  st.wakes = [];
  st.acks = [];
  st.config = {
    type: "postgres",
    mode: "connector",
    connection_secret_key: "operator_db.connection_string",
    disabled_tables: [],
    hidden_fields: ["users.email"],
    unhidden_fields: [],
    auto_hide: true,
    settings_confirmed_at: null,
    policy_catalog_hash: null,
  };
  st.catalog = {
    dialect: "postgres",
    catalog: { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "plan" }] }, { name: "bookings", columns: [{ name: "id" }, { name: "city" }] }] },
    hints: {},
    catalog_hash: "h1",
    discovery_error: null,
  };
  st.connector = { id: "conn-1", machine_name: "mac-1", version: "1.0.0", dialect: "postgres", rules: null, last_seen_at: new Date().toISOString(), last_skipped_feature: null, last_skipped_at: null, created_at: new Date().toISOString() };
  st.getSecret.mockReset().mockResolvedValue("postgres://should-never-be-read");
  st.rpc.mockReset();
  st.reserve.mockReset().mockResolvedValue("log-1");
  st.finalize.mockReset().mockResolvedValue(undefined);
  st.refusal.mockReset().mockResolvedValue("log-r");
});

describe("source / policy generation fence (final review finding 1)", () => {
  it("the read is enqueued with the generation it was resolved under", async () => {
    queue(rows(["id"], [[1]]));
    await withReadSession(agent, (s) => s.query("SELECT id FROM bookings"));
    const enq = st.rpc.mock.calls.find((c) => c[1] === "enqueue_db_connector_request")!;
    expect(enq[2]).toMatchObject({ p_generation: 0 });
    expect(st.reserve.mock.calls[0]![0]).toMatchObject({ generation: 0 });
    expect(st.finalize.mock.calls.at(-1)![2]).toMatchObject({ result: "allowed", generation: 0 });
  });
  it("a result the cloud discarded because the connector's source changed -> db_source_changed, nothing returned", async () => {
    queue({ status: "failed", reason: "source_changed" });
    await expect(withReadSession(agent, (s) => s.query("SELECT id FROM bookings"))).rejects.toMatchObject({ code: "db_source_changed" });
  });
  it("a finalize that finds the generation moved drops the rows (db_source_changed)", async () => {
    queue(rows(["id"], [[1]]));
    const { DbSourceChangedError } = await import("../../types");
    st.finalize.mockImplementation(async (_id: string, _ctx: unknown, f: { result: string }) => {
      if (f.result === "allowed") throw new DbSourceChangedError();
    });
    await expect(withReadSession(agent, (s) => s.query("SELECT id FROM bookings"))).rejects.toMatchObject({ code: "db_source_changed" });
  });
});

describe("connector mode: no cloud-held password (Task 4.7 hermetic)", () => {
  it("a codeact-style read is enqueued for the token's tenant, Vault is never read, the audit says connector", async () => {
    const ops = queue(rows(["id", "city"], [[1, "Austin"]]));
    const out = await withReadSession(agent, (s) => s.query("SELECT id, city FROM bookings", [], { maxRows: 50 }));
    expect(out.rows).toEqual([{ id: 1, city: "Austin" }]);
    expect(st.getSecret).not.toHaveBeenCalled();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "sql", max_rows: 50 });
    expect(st.wakes).toEqual([TENANT]);
    expect(st.reserve.mock.calls[0]![0]).toMatchObject({ mode: "connector", ctx: { tenant_id: TENANT } });
    expect(st.finalize.mock.calls[0]![2]).toMatchObject({ result: "allowed", row_count: 1 });
  });
  it("Zavi's own settings still apply first: a hidden field is refused before anything is enqueued", async () => {
    const ops = queue(rows(["email"], [["a@b.c"]]));
    await expect(withReadSession(agent, (s) => s.query("SELECT email FROM users"))).rejects.toBeInstanceOf(GatewayRefusal);
    expect(ops).toHaveLength(0);
  });
  it("a hidden column a connector sends anyway is stripped (last backstop)", async () => {
    queue(rows(["id", "email", "plan"], [[1, "a@b.c", "pro"]]));
    const out = await withReadSession(agent, (s) => s.query("SELECT * FROM users"));
    expect(out.rows).toEqual([{ id: 1, plan: "pro" }]);
  });
});

describe("connector refusals and bad answers", () => {
  it("refused -> 'Refused by your connector', audit refused by connector, run noted, agent re-plans", async () => {
    queue({ status: "refused", reason: "bookings is not an allowed table" });
    const p = collectAccessNotes(() => withReadSession(agent, (s) => s.query("SELECT id FROM bookings")));
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(GatewayRefusal);
    expect(err.message).toBe("Refused by your connector: bookings is not an allowed table");
    expect(err.refused_by).toBe("connector");
    expect(st.finalize.mock.calls[0]![2]).toMatchObject({ result: "refused", refused_by: "connector", reason: "bookings is not an allowed table" });
    expect(peekRunNotes("run-1")).toEqual([{ kind: "refused", refused_by: "connector", reason: "bookings is not an allowed table", tables: ["bookings"] }]);
    expect(err.access_notes).toEqual([expect.objectContaining({ result: "refused", refused_by: "connector", mode: "connector" })]);
  });
  it("totals-only rules -> the refusal points the agent at operator_db__summary", async () => {
    st.connector = { ...st.connector!, rules: { allowed_tables: ["bookings"], blocked_fields: [], what_can_leave: "totals_and_counts_only", max_rows: 200 } };
    queue({ status: "refused", reason: "only totals and counts may leave" });
    const err = await withReadSession(agent, (s) => s.query("SELECT id FROM bookings")).catch((e) => e);
    expect(err.message).toContain("Use operator_db__summary.");
    expect(st.finalize.mock.calls[0]![2]).toMatchObject({ totals_only: true });
  });
  it("oversized / malformed answer -> failed read, nothing reaches the caller", async () => {
    queue({ status: "done", result: { status: "done", data: { kind: "rows", columns: ["x"], rows: [["y".repeat(5000)]], truncated: false, removed_columns: [], rule: "rows_without_blocked_columns" } } });
    const err = await withReadSession(agent, (s) => s.query("SELECT id FROM bookings")).catch((e) => e);
    expect(err.code).toBe("connector_invalid_result");
    expect(st.finalize.mock.calls[0]![2]).toMatchObject({ result: "failed", reason: "connector sent an invalid result" });
    queue({ status: "done", result: { status: "done", data: { kind: "nonsense" } } });
    await expect(withReadSession(agent, (s) => s.query("SELECT id FROM bookings"))).rejects.toMatchObject({ code: "connector_invalid_result" });
  });
  it("a read that fails on the connector is a recoverable failed read", async () => {
    queue({ status: "failed", reason: "relation does not exist" });
    await expect(withReadSession(agent, (s) => s.query("SELECT id FROM bookings"))).rejects.toMatchObject({ code: "connector_read_failed" });
  });
  it("no answer in time and the connector stopped checking in -> handled as offline, not a timeout", async () => {
    queue("never");
    const { openConnectorSession } = await import("../session");
    let t = Date.now();
    let reads = 0;
    const live = { ...st.connector! };
    const s = await openConnectorSession(background, "postgres", { generation: 0 }, {
      now: () => t,
      waitTimeoutMs: 1000,
      readConnector: async () => (++reads === 1 ? live : { ...live, last_seen_at: new Date(t - 120_000).toISOString() }) as never,
      queue: { now: () => t, sleep: async (ms) => void (t += ms), wake: async () => undefined },
    });
    await expect(s.query("SELECT 1")).rejects.toBeInstanceOf(ConnectorOfflineError);
    expect(st.sent.length).toBeGreaterThan(0);
  });
  it("no answer in time -> cancelled, connector_timeout", async () => {
    queue("never");
    const { openConnectorSession } = await import("../session");
    let t = 0;
    const s = await openConnectorSession(agent, "postgres", { generation: 0 }, { now: () => t, waitTimeoutMs: 1000, queue: { now: () => t, sleep: async (ms) => void (t += ms) } });
    await expect(s.query("SELECT 1")).rejects.toMatchObject({ code: "connector_timeout" });
    expect(st.rpc.mock.calls.some((c) => c[1] === "cancel_db_connector_request")).toBe(true);
  });
});

describe("connector offline", () => {
  beforeEach(() => {
    st.connector = { ...st.connector!, last_seen_at: new Date(Date.now() - 7_200_000).toISOString() };
  });
  it("agent: nothing enqueued, audit failed 'connector offline', run noted, message offers to answer without the data", async () => {
    const ops = queue(rows(["id"], [[1]]));
    const err = await withReadSession(agent, (s) => s.query("SELECT id FROM bookings")).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorOfflineError);
    expect(err.message).toContain("mac-1");
    expect(err.message).toContain("answer without their data");
    expect(ops).toHaveLength(0);
    expect(st.finalize.mock.calls[0]![2]).toMatchObject({ result: "failed", reason: "connector offline" });
    expect(peekRunNotes("run-1")).toEqual([{ kind: "offline", machine: "mac-1", last_seen_at: expect.any(String) }]);
    expect(st.sent).toHaveLength(0);
  });
  it("background: skips, and owners/admins get ONE email per offline period", async () => {
    const ops = queue(rows(["id"], [[1]]));
    await expect(withReadSession(background, (s) => s.query("SELECT id FROM bookings"))).rejects.toBeInstanceOf(ConnectorOfflineError);
    await expect(withReadSession(background, (s) => s.query("SELECT id FROM bookings"))).rejects.toBeInstanceOf(ConnectorOfflineError);
    expect(ops).toHaveLength(0);
    expect(st.sent).toHaveLength(2);
    const [to, subject, , text] = st.sent[0] as [string, string, string, string];
    expect(to).toBe("owner@x.co");
    expect(subject).toBe("Booking metrics skipped: your Zavi Connector is offline");
    expect(text).toContain("docker restart zavi-connector on mac-1");
    expect(st.acks).toEqual([{ p_notice_id: "notice-1", p_delivered: 2, p_error: null }]);
  });
  it("background, no owner/admin email -> nothing marked sent; the notice backs off for a retry", async () => {
    queue(rows(["id"], [[1]]));
    const base = st.rpc.getMockImplementation()!;
    st.rpc.mockImplementation(async (tid: string, name: string, args: Record<string, unknown>) =>
      name === "tenant_admin_emails" ? { data: [], error: null } : base(tid, name, args),
    );
    await expect(withReadSession(background, (s) => s.query("SELECT id FROM bookings"))).rejects.toBeInstanceOf(ConnectorOfflineError);
    expect(st.sent).toHaveLength(0);
    expect(st.acks).toEqual([{ p_notice_id: "notice-1", p_delivered: 0, p_error: "no owner or admin email" }]);
  });
});

describe("connector mongo", () => {
  it("filters and docs cross as EJSON (dates survive both ways)", async () => {
    st.config = { ...st.config!, type: "mongodb", hidden_fields: [] };
    st.catalog = { ...st.catalog!, dialect: "mongodb", catalog: { tables: [{ name: "trips", columns: [{ name: "_id" }, { name: "start" }, { name: "city" }] }] } };
    const when = new Date("2026-01-02T03:04:05.000Z");
    const doc = BSON.EJSON.serialize({ city: "Austin", start: when }, { relaxed: true });
    const ops = queue({ status: "done", result: { status: "done", data: { kind: "docs", docs: [doc], truncated: false, removed_columns: [], rule: "rows_without_blocked_columns" } } });
    const out = await withReadSession(agent, (s) => s.mongo().find("trips", { start: { $gte: when } }, { limit: 5 }));
    expect((ops[0] as { filter: unknown }).filter).toEqual({ start: { $gte: { $date: "2026-01-02T03:04:05Z" } } });
    expect(out[0]!.start).toBeInstanceOf(Date);
    expect((out[0]!.start as Date).toISOString()).toBe(when.toISOString());
  });

  it("an aggregate cut at the connector's row cap: returned to an agent, refused to a caller that adds rows up", async () => {
    st.config = { ...st.config!, type: "mongodb", hidden_fields: [] };
    st.catalog = { ...st.catalog!, dialect: "mongodb", catalog: { tables: [{ name: "trips", columns: [{ name: "_id" }, { name: "city" }] }] } };
    const cut = { status: "done", result: { status: "done", data: { kind: "docs", docs: [{ city: "Austin" }], truncated: true, removed_columns: [], rule: "rows_without_blocked_columns" } } };
    queue(cut);
    const rows = await withReadSession(agent, (s) => s.mongo().aggregate("trips", [{ $match: { city: "Austin" } }]));
    expect(rows).toHaveLength(1);
    queue(cut);
    await expect(
      withReadSession(agent, (s) => s.mongo().aggregate("trips", [{ $match: { city: "Austin" } }], { failIfTruncated: true })),
    ).rejects.toMatchObject({ code: "connector_rows_truncated" });
  });
});
