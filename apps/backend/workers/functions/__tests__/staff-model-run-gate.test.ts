import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  owner: true as boolean | Error,
  cap: { ok: true } as { ok: true } | { ok: false; spent: number; cap: number },
}));
vi.mock("@/services/auth/staff-model-access", () => ({
  isTenantOwnerOrAdmin: vi.fn(async () => { if (h.owner instanceof Error) throw h.owner; return h.owner; }),
  checkStaffModelCap: vi.fn(async () => h.cap),
}));

import { checkStaffModelAtExecution } from "../staff-model-run-gate";

const db = {} as never;
const P = { staff_model: { key: "qwen", by: "u1" } };

describe("checkStaffModelAtExecution", () => {
  it("no staff_model → ok (normal runs untouched)", async () => {
    expect(await checkStaffModelAtExecution(db, "t", { thread_id: "x" })).toEqual({ ok: true });
  });
  it("still owner/admin + under cap → ok", async () => {
    h.owner = true; h.cap = { ok: true };
    expect(await checkStaffModelAtExecution(db, "t", P)).toEqual({ ok: true });
  });
  it("no longer owner or admin (demoted/removed while queued) → refused", async () => {
    h.owner = false;
    expect((await checkStaffModelAtExecution(db, "t", P)).ok).toBe(false);
  });
  it("cap reached while queued → refused", async () => {
    h.owner = true; h.cap = { ok: false, spent: 205, cap: 200 };
    expect(await checkStaffModelAtExecution(db, "t", P)).toEqual({ ok: false, reason: "daily ?model= test cap reached ($200)" });
  });
  it("access read error → refused (fail closed)", async () => {
    h.owner = new Error("db down"); h.cap = { ok: true };
    expect((await checkStaffModelAtExecution(db, "t", P)).ok).toBe(false);
  });
  it("stamp without an authorizing user → refused", async () => {
    h.owner = true; h.cap = { ok: true };
    expect((await checkStaffModelAtExecution(db, "t", { staff_model: { key: "qwen" } })).ok).toBe(false);
  });
});
