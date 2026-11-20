
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("inject sb"); } }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

import { settleProvisioningRow, RETIRED_REASON } from "../auto-provision-tenant";

type Row = Record<string, unknown>;

function fakeDb(state: { provisioning: Row | null; membership: Row | null }) {
  const calls: Array<{ table: string; op: string; patch?: Row }> = [];
  const db = {
    rpc: () => {
      calls.push({ table: "rpc", op: "rpc" });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      let patch: Row | undefined;
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = chain;
      b.eq = chain;
      b.neq = chain;
      b.limit = chain;
      b.update = (p: Row) => {
        patch = p;
        calls.push({ table, op: "update", patch: p });
        if (table === "tenant_provisioning" && state.provisioning) Object.assign(state.provisioning, p);
        return b;
      };
      for (const op of ["insert", "upsert", "delete"]) {
        b[op] = () => {
          calls.push({ table, op });
          return b;
        };
      }
      b.maybeSingle = async () => ({
        data: table === "tenant_provisioning" ? state.provisioning : table === "tenant_users" ? state.membership : null,
        error: null,
      });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: patch ? [patch] : [], error: null });
      return b;
    },
  };
  return { db, calls };
}

describe("settleProvisioningRow (retired lazy provisioning)", () => {
  it("a pending row for a user who already has a tenant becomes ready with that tenant", async () => {
    const state = { provisioning: { status: "pending", tenant_id: null }, membership: { tenant_id: "t-real" } };
    const { db, calls } = fakeDb(state);
    const r = await settleProvisioningRow("u-1", db as never);
    expect(r).toEqual({ status: "ready", tenant_id: "t-real" });
    expect(state.provisioning).toMatchObject({ status: "ready", tenant_id: "t-real" });
    expect(calls.filter((c) => c.op !== "update")).toEqual([]);
  });

  it("a pending row for a user with no tenant becomes failed, and no tenant is created", async () => {
    const state = { provisioning: { status: "pending", tenant_id: null }, membership: null };
    const { db, calls } = fakeDb(state);
    const r = await settleProvisioningRow("u-2", db as never);
    expect(r).toEqual({ status: "failed", tenant_id: null });
    expect(state.provisioning).toMatchObject({ status: "failed", failure_reason: RETIRED_REASON });
    expect(calls.some((c) => c.table === "rpc" || c.table === "tenants" || c.table === "profiles")).toBe(false);
  });

  it("an already-ready row is left alone", async () => {
    const state = { provisioning: { status: "ready", tenant_id: "t-1" }, membership: null };
    const { db, calls } = fakeDb(state);
    expect(await settleProvisioningRow("u-3", db as never)).toEqual({ status: "ready", tenant_id: "t-1" });
    expect(calls).toEqual([]);
  });

  it("no row at all: nothing to settle, nothing written", async () => {
    const { db, calls } = fakeDb({ provisioning: null, membership: null });
    expect(await settleProvisioningRow("u-4", db as never)).toEqual({ status: "absent", tenant_id: null });
    expect(calls).toEqual([]);
  });
});
