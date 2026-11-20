import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { resolveSignupTarget } from "../signup-followup";

type Row = Record<string, unknown>;
function fakeClient(tables: Record<string, Row[]>, failing: string[] = []) {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return b;
      };
      b.maybeSingle = async () => {
        if (failing.includes(table)) return { data: null, error: { message: "boom" } };
        const row = (tables[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        return { data: row ?? null, error: null };
      };
      return b;
    },
  };
}

const TENANT = { id: "t1", slug: "acme", display_name: "Acme", created_at: null, kind: "real", deleted_at: null };

describe("resolveSignupTarget", () => {
  it("returns the re-read tenant and a member's user id", async () => {
    const sb = fakeClient({ tenants: [TENANT], tenant_users: [{ tenant_id: "t1", user_id: "u1" }] });
    expect(await resolveSignupTarget(sb, "t1", "u1")).toEqual({ tenant: TENANT, user_id: "u1" });
  });

  it("drops a user id that does not belong to the tenant", async () => {
    const sb = fakeClient({ tenants: [TENANT], tenant_users: [{ tenant_id: "t2", user_id: "u9" }] });
    expect(await resolveSignupTarget(sb, "t1", "u9")).toEqual({ tenant: TENANT, user_id: null });
  });

  it("returns null for a tenant that does not exist", async () => {
    expect(await resolveSignupTarget(fakeClient({ tenants: [] }), "t404", "u1")).toBeNull();
  });

  it("throws on a read error so the step retries", async () => {
    await expect(resolveSignupTarget(fakeClient({}, ["tenants"]), "t1", null)).rejects.toThrow(/tenant read failed/);
    await expect(
      resolveSignupTarget(fakeClient({ tenants: [TENANT] }, ["tenant_users"]), "t1", "u1"),
    ).rejects.toThrow(/membership read failed/);
  });
});
