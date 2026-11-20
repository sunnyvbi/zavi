import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";
vi.mock("@/services/data-gateway/audit", () => ({ reserveAudit: vi.fn(async () => "audit"), finalizeAudit: vi.fn(async () => {}), writeRefusalAudit: vi.fn(async () => "refusal") }));
import { loggedSession } from "@/services/data-gateway/logged-session";
import { fakeSession } from "@/services/data-gateway/__tests__/fake-session";
import type { DbAccess } from "@/services/data-gateway/resolve";
import { attachSession } from "../session-attach";
import { mongoDriver } from "../drivers/mongo";
import type { SchemaMap } from "../types";
import { _resetRunNotes } from "@/services/data-gateway/run-reads";
const catalog = { tables: [{ name: "trips", columns: [{ name: "city" }, { name: "secret" }] }] };
const access = { tenant_id: "t", dialect: "mongodb", policy: effectivePolicy({ auto_hide: false, hidden_fields: ["trips.secret"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb") } as DbAccess;
function setup(rows: Record<string, unknown>[]) {
  const { session, calls } = fakeSession({ dialect: "mongodb", docs: rows });
  const cfg = attachSession({} as SchemaMap, loggedSession(session, access, { tenant_id: "t", caller: { kind: "agent", agent_slug: "operator", run_id: "r", tool_name: "operator_db__query" } }));
  return { cfg, calls };
}
beforeEach(_resetRunNotes);
describe("real driver → adapter → guarded and audited gateway", () => {
  it("executes a default-limit aggregate once and still strips hidden data", async () => {
    const { cfg, calls } = setup([{ city: "Atlanta", secret: "hidden" }]);
    const result = await mongoDriver().aggregate!("trips", [{ $limit: 1 }], {}, cfg, new Set(["trips"]));
    expect(result).toMatchObject({ ok: true, data: { row_count: 1, truncated: false, rows: [{ city: "Atlanta" }] } });
    expect(calls.mongo).toHaveLength(1);
  });
  it.each(["find", "aggregate"])("%s preserves all 5000 allowed rows and never claims a full capped page is exhaustive", async mode => {
    const { cfg } = setup(Array.from({ length: 5000 }, () => ({ city: "Atlanta" })));
    const driver = mongoDriver();
    const result = mode === "find"
      ? await driver.query_collection!("trips", {}, {}, cfg, new Set(["trips"]))
      : await driver.aggregate!("trips", [{ $match: { city: "Atlanta" } }], {}, cfg, new Set(["trips"]));
    expect(result).toMatchObject({ ok: true, data: { row_count: 5000, truncated: true } });
  });
  it("retains exact extra-row detection below the ceiling", async () => {
    const { cfg } = setup([{ city: "a" }, { city: "b" }, { city: "c" }]);
    const result = await mongoDriver().aggregate!("trips", [], { limit: 2 }, cfg, new Set(["trips"]));
    expect(result).toMatchObject({ ok: true, data: { row_count: 2, truncated: true, rows: [{ city: "a" }, { city: "b" }] } });
  });
  it("accepts a pipeline with its own small $limit and still refuses a user $limit over the cap", async () => {
    const { cfg, calls } = setup([{ city: "a" }]);
    const driver = mongoDriver();
    await expect(driver.aggregate!("trips", [{ $match: { city: "a" } }, { $limit: 40 }], {}, cfg, new Set(["trips"]))).resolves.toMatchObject({ ok: true });
    await expect(driver.aggregate!("trips", [{ $limit: 10000 }], {}, cfg, new Set(["trips"]))).rejects.toMatchObject({ code: "operator_db_read_rejected" });
    expect(calls.mongo).toHaveLength(1);
  });
  it("still refuses hidden-field queries before reaching the database", async () => {
    const { cfg, calls } = setup([]);
    await expect(mongoDriver().aggregate!("trips", [{ $project: { secret: 1 } }], {}, cfg, new Set(["trips"]))).rejects.toMatchObject({ code: "data_access_refused" });
    expect(calls.mongo).toHaveLength(0);
  });
});
