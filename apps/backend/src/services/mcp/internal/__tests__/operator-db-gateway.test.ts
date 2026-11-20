import { describe, it, expect, vi, beforeEach } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";
import { fakeSession } from "@/services/data-gateway/__tests__/fake-session";

const st = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  open: vi.fn(),
  python: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (_t: string, name: string, a: Record<string, unknown>) => {
    if (name === "reserve_data_access") {
      st.inserted.push({ caller_kind: a.p_caller_kind, run_id: a.p_run_id, agent_slug: a.p_agent_slug, tool_name: a.p_tool_name, operation: a.p_operation, result: "pending" });
      return { data: `log-${st.inserted.length}`, error: null };
    }
    if (name === "finalize_data_access") {
      st.updated.push({ result: a.p_result, sent_to_ai: a.p_sent_to_ai, row_count: a.p_row_count });
      return { data: "ok", error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  },
  tenantClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        st.inserted.push(row);
        return { select: () => ({ single: async () => ({ data: { id: `log-${st.inserted.length}` }, error: null }) }) };
      },
      update: (vals: Record<string, unknown>) => {
        st.updated.push(vals);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));
vi.mock("@/services/data-gateway/direct/sql", () => ({ openSqlSession: st.open }));
vi.mock("@/services/data-gateway/resolve", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const catalog = {
    tables: [{ name: "users", columns: [{ name: "id", type: "integer" }, { name: "email", type: "text" }, { name: "role", type: "text" }] }],
  };
  return {
    ...actual,
    loadDbAccess: async (tenant_id: string) => ({
      tenant_id,
      mode: "direct",
      dialect: "postgres",
      config: { type: "postgres", connection_secret_key: "k", schema_map: {} },
      catalog: { catalog, hints: {}, catalog_hash: "h", discovery_error: null },
      policy: effectivePolicy({ auto_hide: false, hidden_fields: ["users.email"], unhidden_fields: [], disabled_tables: [] }, catalog, "postgres"),
      connectionString: "postgres://x",
    }),
  };
});
vi.mock("@/services/sandbox/codeact-sandbox", () => ({ runCodeActPython: st.python }));
vi.mock("@/services/analytics/tenant-timezone", () => ({ resolveReportingTimezone: async () => ({ tz: "UTC" }) }));
vi.mock("@/services/analytics/verified-queries", () => ({ findSimilarVerifiedQueries: async () => [] }));
vi.mock("@/services/analytics/data-notes", () => ({ listActiveDataNotes: async () => [] }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { callOperatorDbTool } from "../operator-db";

let lastSession: ReturnType<typeof fakeSession> | null = null;
beforeEach(() => {
  st.inserted.length = 0;
  st.updated.length = 0;
  st.open.mockReset().mockImplementation(async () => {
    lastSession = fakeSession({ dialect: "postgres", rows: [{ id: 1, email: "a@b.c", role: "host" }] });
    return lastSession.session;
  });
  st.python.mockReset().mockImplementation(async (a: { input: unknown }) => ({ ok: true, result: a.input }));
});

const codeact = (sql: string) =>
  callOperatorDbTool("t1", "codeact", { purpose: "p", sql_reads: [sql], python_code: "result = rows" }, { run_id: "run-1", agent_slug: "pm" });

describe("operator_db tools through the gateway", () => {
  it("codeact SELECT * FROM users with hidden email: no email anywhere, audit row for the agent", async () => {
    const r = await codeact("SELECT * FROM users");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(st.python.mock.calls[0]![0])).not.toContain("a@b.c");
    expect(r.content).not.toContain("a@b.c");
    expect(lastSession!.calls.sql[0]!.text).toMatch(/^SELECT \* FROM \(SELECT "id", "role" FROM ONLY "public"\."users"\) AS "users"/);
    expect(st.inserted[0]).toMatchObject({ caller_kind: "agent", run_id: "run-1", agent_slug: "pm", tool_name: "operator_db__codeact", result: "pending" });
    expect(st.updated[0]).toMatchObject({ result: "allowed", sent_to_ai: true, row_count: 1 });
    expect(r.access_notes).toEqual([{ log_id: "log-1", mode: "direct", tables: ["users"], rows: 1, result: "allowed" }]);
  });
  it("a refused query is ok:false data_access_refused (not a run-killer) with a refused row", async () => {
    const r = await codeact("SELECT email FROM users");
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ error: "data_access_refused" });
    expect(lastSession!.calls.sql).toHaveLength(0);
    expect(st.inserted[0]).toMatchObject({ result: "refused", refused_by: "zavi", sent_to_ai: false });
    expect(r.access_notes?.[0]).toMatchObject({ result: "refused" });
  });
  it("summary min on users.email is refused", async () => {
    const r = await callOperatorDbTool("t1", "summary", { table: "users", measures: [{ fn: "min", field: "email" }] }, { run_id: "run-1" });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ error: "data_access_refused" });
  });
  it("summary count by role runs with the >= 5 floor and returns only big groups", async () => {
    st.open.mockImplementation(async () => {
      lastSession = fakeSession({ dialect: "postgres", rows: [{ role: "host", __n: 7, count: 7 }, { role: "admin", __n: 2, count: 2 }] });
      return lastSession.session;
    });
    const r = await callOperatorDbTool("t1", "summary", { table: "users", measures: [{ fn: "count" }], group_by: [{ field: "role" }] }, { run_id: "run-1" });
    expect(r.ok).toBe(true);
    expect(lastSession!.calls.sql[0]!.text).toContain("HAVING count(*) >= 5");
    expect(JSON.parse(r.content).data.rows).toEqual([{ role: "host", __n: 7, count: 7 }]);
    expect(st.inserted[0]).toMatchObject({ operation: "summary" });
  });
});
