
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn(async () => ({ ids: ["x"] }));
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => send(...(a as [])) } }));

vi.mock("@/services/data-gateway", () => ({
  loadDbAccess: async () => {
    throw new Error("operator_db_not_discovered");
  },
  visibleCatalog: (c: unknown) => c,
  withAttachedDriver: async () => ({}),
  collectAccessNotes: async (fn: () => Promise<unknown>) => ({ result: await fn(), notes: [] }),
  resolveAttachedDb: async () => {
    throw new Error("operator_db_not_discovered");
  },
  runSummary: async () => ({ rows: [], table: "" }),
  MANAGED_DB_LOGIN: "zavi_readonly",
  probeCandidate: async () => ({ ok: false, error: "not in this test" }),
}));
vi.mock("@/services/tools/operator-db/catalog", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCatalog: async () => null,
  getDeclaredDialect: async () => "mongodb",
}));

import { callMcpTool } from "@/services/mcp/execute";

let n = 0;
const tenant = () => `00000000-0000-4000-8000-0000000000${String(++n).padStart(2, "0")}`;

beforeEach(() => send.mockClear());

describe("operator_db__catalog rediscovery in a lab run", () => {
  it("writes-suppressed (lab / draft) run: no inngest.send", async () => {
    const t = tenant();
    const r = await callMcpTool({ tenant_id: t, run_id: "r1", writes_suppressed: true }, "operator_db", "catalog", {});
    expect(r.is_error).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("normal run: enqueues one rediscovery", async () => {
    const t = tenant();
    await callMcpTool({ tenant_id: t, run_id: "r2" }, "operator_db", "catalog", {});
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({ name: "operator-db.discover.requested", data: { tenant_id: t } });
  });
});
