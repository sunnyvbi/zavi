import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";
import { fakeSession } from "@/services/data-gateway/__tests__/fake-session";

const st = vi.hoisted(() => ({ reserve: vi.fn(), finalize: vi.fn(), refusal: vi.fn(), open: vi.fn(), dialect: "postgres" as string }));
vi.mock("@/services/data-gateway/audit", () => ({ reserveAudit: st.reserve, finalizeAudit: st.finalize, writeRefusalAudit: st.refusal }));
vi.mock("@/services/data-gateway/direct/sql", () => ({ openSqlSession: st.open }));
vi.mock("@/services/data-gateway/direct/mongo", async (orig) => ({ ...((await orig()) as Record<string, unknown>), openMongoSession: st.open }));
vi.mock("@/services/data-gateway/resolve", () => {
  const catalog = { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }] }, { name: "audit", columns: [{ name: "id" }] }] };
  return {
    loadDbAccess: async () => ({
      tenant_id: "t1",
      mode: "direct",
      dialect: st.dialect,
      config: { type: st.dialect, schema_map: {} },
      catalog: { catalog },
      policy: effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: ["audit"] }, catalog, st.dialect as never),
      connectionString: "x://y",
      database: null,
    }),
  };
});

import { readContactColumn } from "@/services/data-gateway/person";

const ctx = { tenant_id: "t1", caller: { kind: "person" as const, user_id: "u-1", feature: "Contact import" as const } };
let last: ReturnType<typeof fakeSession>;

beforeEach(() => {
  st.dialect = "postgres";
  st.reserve.mockReset().mockResolvedValue("log-1");
  st.finalize.mockReset().mockResolvedValue(undefined);
  st.refusal.mockReset().mockResolvedValue(null);
  st.open.mockReset().mockImplementation(async () => {
    last = fakeSession({ dialect: st.dialect as never, rows: [{ email: "a@b.c" }, { email: "d@e.f" }], docs: [{ email: "a@b.c" }] });
    return last.session;
  });
});

describe("contact import person read", () => {
  it("imports a HIDDEN email column (auto-hidden), one column only, audited as Contact import", async () => {
    const out = await readContactColumn(ctx, "users", "email", 5000);
    expect(out.values).toEqual(["a@b.c", "d@e.f"]);
    expect(last.calls.sql[0]!.text).toBe('SELECT "email" FROM ONLY "public"."users" WHERE "email" IS NOT NULL LIMIT 5001');
    expect(st.reserve.mock.calls[0]![0]).toMatchObject({ ctx: { caller: { kind: "person", feature: "Contact import", user_id: "u-1" } }, tables: ["users"] });
    expect(st.finalize.mock.calls[0]![1]).toBe(ctx);
  });
  it("Mongo projects exactly that field", async () => {
    st.dialect = "mongodb";
    const out = await readContactColumn(ctx, "users", "email", 10);
    expect(out.values).toEqual(["a@b.c"]);
    expect(last.calls.mongo[0]!.args[2]).toEqual({ projection: { email: 1, _id: 0 }, sort: { _id: 1 }, limit: 11 });
    expect(st.reserve.mock.calls[0]![0]).toMatchObject({ query_text: 'find users {"email":{"$type":"string"}} projection {"email":1} sort {"_id":1}' });
  });
  it("a switched-off table is refused before any connection", async () => {
    await expect(readContactColumn(ctx, "audit", "id", 10)).rejects.toMatchObject({ code: "data_access_refused" });
    expect(st.open).not.toHaveBeenCalled();
    expect(st.refusal).toHaveBeenCalledTimes(1);
  });
  it("an unknown column is refused", async () => {
    await expect(readContactColumn(ctx, "users", "password", 10)).rejects.toMatchObject({ code: "operator_db_bad_field" });
    expect(st.open).not.toHaveBeenCalled();
  });
});
