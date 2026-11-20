import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  catalog: null as Record<string, unknown> | null,
  open: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => ({ select: () => ({ maybeSingle: async () => ({ data: st.config, error: null }) }) }) }),
}));
vi.mock("@/services/tools/operator-db/catalog", () => ({ getCatalog: async () => st.catalog, hintsToSchemaMapShape: () => ({}) }));
vi.mock("@/services/tools/operator-db/mapping", () => ({ getConfirmedMapping: async () => null, applyConfirmedMap: (m: unknown) => m }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: async () => "postgres://x" }));
vi.mock("../direct/sql", () => ({ openSqlSession: st.open }));
vi.mock("../audit", () => ({ reserveAudit: vi.fn(async () => "l"), finalizeAudit: vi.fn(), writeRefusalAudit: vi.fn(async () => null) }));

import { loadDbAccess } from "../resolve";
import { withReadSession, runSummary } from "../index";

const row = (over: Record<string, unknown> = {}) => ({
  type: "postgres",
  mode: "direct",
  connection_secret_key: "k",
  disabled_tables: [],
  hidden_fields: [],
  unhidden_fields: ["users.email"],
  auto_hide: true,
  settings_confirmed_at: null,
  policy_catalog_hash: "old",
  ...over,
});
const catalog = (hash: string) => ({ dialect: "postgres", catalog: { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }] }] }, hints: {}, catalog_hash: hash, discovery_error: null });

beforeEach(() => {
  st.config = row();
  st.catalog = catalog("new");
  st.open.mockReset();
});

describe("transitions fail closed", () => {
  it("an un-hide confirmed against the old catalog does not survive a new catalog (auto_hide hides email again)", async () => {
    expect((await loadDbAccess("t1")).policy.isHidden("users", "email")).toBe(true);
    st.catalog = catalog("old");
    expect((await loadDbAccess("t1")).policy.isHidden("users", "email")).toBe(false);
  });
  it("no catalog row (deleted by the transition reset) -> operator_db_not_discovered for every read path, zero sessions opened", async () => {
    st.catalog = null;
    const agent = { tenant_id: "t1", caller: { kind: "agent" as const, agent_slug: "pm", run_id: "r", tool_name: "operator_db__codeact" } };
    const bg = { tenant_id: "t1", caller: { kind: "background" as const, feature: "Booking metrics" } };
    await expect(withReadSession(agent, async () => 1)).rejects.toMatchObject({ code: "operator_db_not_discovered" });
    await expect(withReadSession(bg, async () => 1)).rejects.toMatchObject({ code: "operator_db_not_discovered" });
    await expect(runSummary(agent, { table: "users", measures: [{ fn: "count" }], group_by: [], filters: [], limit: 10 })).rejects.toMatchObject({
      code: "operator_db_not_discovered",
    });
    expect(st.open).not.toHaveBeenCalled();
  });
});
