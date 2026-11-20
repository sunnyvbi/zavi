import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: Record<string, unknown> = {};
const gteCols: string[] = [];
let throwOn: string | null = null;
const db: any = {
    from: (table: string) => {
      const q: any = {
        select: () => q, eq: () => q, is: () => q, not: () => q, gte: (col: string) => { gteCols.push(col); return q; }, order: () => q, range: () => q,
        maybeSingle: async () => (throwOn === table ? { data: null, error: { message: "boom" } } : { data: rows[table] ?? null, error: null }),
        then: (res: any) => res(throwOn === table ? { data: null, error: { message: "boom" } } : { data: rows[table] ?? [], error: null }),
      };
      return q;
    },
};
vi.mock("@/services/settings", () => ({ getNumberSetting: async () => 200 }));

import { isActiveStaffUser, isTenantOwnerOrAdmin, staffModelSpendTodayUsd, checkStaffModelCap } from "../staff-model-access";

beforeEach(() => { for (const k of Object.keys(rows)) delete rows[k]; throwOn = null; });

describe("staff-model-access", () => {
  it("staff: true only for an active row; throws on DB error (fail closed at caller)", async () => {
    rows.staff_users = { user_id: "u1" };
    expect(await isActiveStaffUser(db, "u1")).toBe(true);
    rows.staff_users = null;
    expect(await isActiveStaffUser(db, "u1")).toBe(false);
    throwOn = "staff_users";
    await expect(isActiveStaffUser(db, "u1")).rejects.toThrow();
  });
  it("owner or admin: true for owner and admin, false for member / no row", async () => {
    rows.tenant_users = { role: "owner" };
    expect(await isTenantOwnerOrAdmin(db, "u1", "t1")).toBe(true);
    rows.tenant_users = { role: "admin" };
    expect(await isTenantOwnerOrAdmin(db, "u1", "t1")).toBe(true);
    rows.tenant_users = { role: "member" };
    expect(await isTenantOwnerOrAdmin(db, "u1", "t1")).toBe(false);
    rows.tenant_users = null;
    expect(await isTenantOwnerOrAdmin(db, "u1", "t1")).toBe(false);
    throwOn = "tenant_users";
    await expect(isTenantOwnerOrAdmin(db, "u1", "t1")).rejects.toThrow();
  });
  it("spend sums cost_usd of today's staff_model runs", async () => {
    rows.agent_runs = [{ cost_usd: 1.5 }, { cost_usd: 2 }, { cost_usd: null }];
    expect(await staffModelSpendTodayUsd(db)).toBeCloseTo(3.5);
  });
  it("cap: blocks at or over the setting", async () => {
    rows.agent_runs = [{ cost_usd: 199 }];
    expect((await checkStaffModelCap(db)).ok).toBe(true);
    rows.agent_runs = [{ cost_usd: 200 }];
    expect(await checkStaffModelCap(db)).toEqual({ ok: false, spent: 200, cap: 200 });
  });
  it("module never imports the service-role client (tenant-isolation [added-import])", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../staff-model-access.ts"), "utf-8");
    expect(src).not.toMatch(/import\s*\{[^}]*\bserviceClient\b/);
  });
  it("cap: a spend read error fails closed", async () => {
    throwOn = "agent_runs";
    expect((await checkStaffModelCap(db)).ok).toBe(false);
  });
  it("filters today's spend on enqueued_at (agent_runs has no created_at column)", async () => {
    gteCols.length = 0;
    rows.agent_runs = [];
    await staffModelSpendTodayUsd(db);
    expect(gteCols).toEqual(["enqueued_at"]);
  });
});
