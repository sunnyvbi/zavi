import { describe, it, expect, vi } from "vitest";
import { inheritStaffModel } from "../staff-model-inherit";

const readParent = (payload: unknown) => vi.fn(async () => payload);
const okCap = async () => ({ ok: true as const });

describe("inheritStaffModel", () => {
  it("no parent id (cron, reminder, standing order) → payload unchanged, no read", async () => {
    const r = readParent({ staff_model: { key: "qwen" } });
    expect(await inheritStaffModel({ payload: { a: 1 }, parent_run_id: undefined, tenant_id: "t" }, { readParentPayload: r, checkCap: okCap })).toEqual({ payload: { a: 1 } });
    expect(r).not.toHaveBeenCalled();
  });
  it("guard: a reminder-shaped payload with no parent never gains staff_model", async () => {
    const r = await inheritStaffModel({ payload: { reminder: {} }, parent_run_id: undefined, tenant_id: "t" }, { readParentPayload: readParent({ staff_model: { key: "qwen" } }), checkCap: okCap });
    expect((r.payload as Record<string, unknown>).staff_model).toBeUndefined();
  });
  it("parent without staff_model → unchanged", async () => {
    expect(await inheritStaffModel({ payload: { a: 1 }, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: readParent({}), checkCap: okCap })).toEqual({ payload: { a: 1 } });
  });
  it("parent with staff_model → copied (only the key)", async () => {
    expect(await inheritStaffModel({ payload: { a: 1 }, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: readParent({ staff_model: { key: "kimi", x: "evil" } }), checkCap: okCap }))
      .toEqual({ payload: { a: 1, staff_model: { key: "kimi" } } });
  });
  it("Claude variant key is inherited too", async () => {
    expect(await inheritStaffModel({ payload: {}, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: readParent({ staff_model: { key: "opus-high" } }), checkCap: okCap }))
      .toEqual({ payload: { staff_model: { key: "opus-high" } } });
  });
  it("unknown key on parent → not copied", async () => {
    expect(await inheritStaffModel({ payload: {}, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: readParent({ staff_model: { key: "llama" } }), checkCap: okCap })).toEqual({ payload: {} });
  });
  it("cap reached → throws StaffModelCapError", async () => {
    await expect(inheritStaffModel({ payload: {}, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: readParent({ staff_model: { key: "kimi" } }), checkCap: async () => ({ ok: false as const, spent: 200, cap: 200 }) }))
      .rejects.toThrow("staff_model_cap");
  });
  it("parent in another tenant → read returns null → unchanged", async () => {
    const r = vi.fn(async (_id: string, t: string) => (t === "other" ? { staff_model: { key: "kimi" } } : null));
    expect(await inheritStaffModel({ payload: {}, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: r, checkCap: okCap })).toEqual({ payload: {} });
    expect(r).toHaveBeenCalledWith("p", "t");
  });
  it("parent read throws → unchanged (child runs on Claude)", async () => {
    expect(await inheritStaffModel({ payload: { a: 1 }, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: vi.fn(async () => { throw new Error("db"); }), checkCap: okCap })).toEqual({ payload: { a: 1 } });
  });
  it("carries the authorizing staff user so the child is re-checked at execution", async () => {
    expect(await inheritStaffModel({ payload: {}, parent_run_id: "p", tenant_id: "t" }, { readParentPayload: readParent({ staff_model: { key: "kimi", by: "u1" } }), checkCap: okCap }))
      .toEqual({ payload: { staff_model: { key: "kimi", by: "u1" } } });
  });
});
