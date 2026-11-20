import { describe, it, expect, vi, beforeEach } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";
import { fakeSession } from "@/services/data-gateway/__tests__/fake-session";

const st = vi.hoisted(() => ({ reserve: vi.fn(), finalize: vi.fn(), open: vi.fn(), gen: 4 }));
vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: st.reserve,
  finalizeAudit: st.finalize,
  writeRefusalAudit: vi.fn(async () => null),
}));
vi.mock("@/services/data-gateway/direct/sql", () => ({ openSqlSession: st.open }));
vi.mock("@/services/data-gateway/resolve", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const catalog = { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "role" }] }] };
  return {
    ...actual,
    readDbGeneration: async () => st.gen,
    loadDbAccess: async (tenant_id: string) => ({
      generation: st.gen,
      tenant_id,
      mode: "direct",
      dialect: "postgres",
      config: { type: "postgres", connection_secret_key: "k", schema_map: { users: { table: "users", id_field: "id" } } },
      catalog: { catalog, hints: {}, catalog_hash: "h", discovery_error: null },
      policy: effectivePolicy({ auto_hide: false, hidden_fields: ["users.email"], unhidden_fields: [], disabled_tables: [] }, catalog, "postgres"),
      connectionString: "postgres://x",
    }),
  };
});

import { LAB_READ_RETRY, labSharedRead, newLabReadCache, withLabReadCache } from "../lab-read-cache";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";

LAB_READ_RETRY.ms = 0;

beforeEach(() => {
  st.reserve.mockReset().mockResolvedValue("log-1");
  st.finalize.mockReset().mockResolvedValue(undefined);
  st.open.mockReset().mockImplementation(async () => fakeSession({ dialect: "postgres", rows: [{ id: "u1", email: "a@b.c", role: "host" }] }).session);
});

describe("lab read cache over the data gateway", () => {
  it("after a transition (generation moved) an earlier column's result is never replayed", async () => {
    st.gen = 4;
    const cache = newLabReadCache();
    const col = (run_id: string) =>
      withLabReadCache(cache, () =>
        labSharedRead("t1", "operator_db", "query_user", { user_id: "u1" }, () =>
          callOperatorDbTool("t1", "query_user", { user_id: "u1" }, { run_id, agent_slug: "pm" }),
        ),
      );
    await col("run-a");
    st.gen = 5;
    await col("run-b");
    expect(st.open).toHaveBeenCalledTimes(2);
    st.gen = 4;
  });
  it("one gateway read for identical reads across columns, filtered content shared", async () => {
    const cache = newLabReadCache();
    const col = (run_id: string) =>
      withLabReadCache(cache, () =>
        labSharedRead("t1", "operator_db", "query_user", { user_id: "u1" }, () =>
          callOperatorDbTool("t1", "query_user", { user_id: "u1" }, { run_id, agent_slug: "pm" }),
        ),
      );
    const [a, b] = await Promise.all([col("run-a"), col("run-b")]);
    expect(st.open).toHaveBeenCalledTimes(1);
    expect(st.reserve).toHaveBeenCalledTimes(1);
    expect(a.content).toBe(b.content);
    expect(a.content).not.toContain("a@b.c");
    expect(JSON.parse(a.content)).toMatchObject({ ok: true, data: { id: "u1", role: "host" } });
  });
});
