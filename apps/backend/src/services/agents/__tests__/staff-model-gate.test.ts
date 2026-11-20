import { describe, it, expect, vi } from "vitest";
import { decideStaffModel } from "../staff-model-gate";

const deps = (o: Partial<Parameters<typeof decideStaffModel>[1]> = {}) => ({
  isOwnerOrAdmin: vi.fn(async () => true),
  checkCap: vi.fn(async () => ({ ok: true as const })),
  hasOpenRouterKey: () => true,
  ...o,
});

describe("decideStaffModel", () => {
  it("no param → none, no DB reads", async () => {
    const d = deps();
    expect(await decideStaffModel({ raw: undefined, userId: "u", tenantId: "t" }, d)).toEqual({ kind: "none" });
    expect(d.isOwnerOrAdmin).not.toHaveBeenCalled();
  });
  it("claude → none", async () => {
    expect(await decideStaffModel({ raw: "claude", userId: "u", tenantId: "t" }, deps())).toEqual({ kind: "none" });
  });
  it("not an owner or admin (member) → silently ignored", async () => {
    expect(await decideStaffModel({ raw: "qwen", userId: "u", tenantId: "t" }, deps({ isOwnerOrAdmin: vi.fn(async () => false) }))).toEqual({ kind: "none" });
  });
  it("member with an unknown name → still silently ignored (no 400 leak)", async () => {
    expect(await decideStaffModel({ raw: "llama", userId: "u", tenantId: "t" }, deps({ isOwnerOrAdmin: vi.fn(async () => false) }))).toEqual({ kind: "none" });
  });
    it("role check throws → ignored (fail closed, chat still works)", async () => {
    expect(await decideStaffModel({ raw: "qwen", userId: "u", tenantId: "t" }, deps({ isOwnerOrAdmin: vi.fn(async () => { throw new Error("x"); }) }))).toEqual({ kind: "none" });
  });
  it("owner/admin unknown name → 400 listing names", async () => {
    const r = await decideStaffModel({ raw: "llama", userId: "u", tenantId: "t" }, deps());
    expect(r).toMatchObject({ kind: "reject", status: 400, code: "unknown_model" });
    expect((r as any).message).toContain("qwen");
  });
  it("over cap → 429", async () => {
    const r = await decideStaffModel({ raw: "qwen", userId: "u", tenantId: "t" }, deps({ checkCap: vi.fn(async () => ({ ok: false as const, spent: 201, cap: 200 })) }));
    expect(r).toMatchObject({ kind: "reject", status: 429, code: "staff_model_cap" });
  });
  it("missing OpenRouter key → 503", async () => {
    const r = await decideStaffModel({ raw: "qwen", userId: "u", tenantId: "t" }, deps({ hasOpenRouterKey: () => false }));
    expect(r).toMatchObject({ kind: "reject", status: 503, code: "openrouter_not_configured" });
  });
  it("Claude variant does not need the OpenRouter key", async () => {
    expect(await decideStaffModel({ raw: "opus-xhigh", userId: "u", tenantId: "t" }, deps({ hasOpenRouterKey: () => false }))).toEqual({ kind: "stamp", staff_model: { key: "opus-xhigh" } });
  });
  it("happy path → stamp {key} only", async () => {
    expect(await decideStaffModel({ raw: "Qwen", userId: "u", tenantId: "t" }, deps())).toEqual({ kind: "stamp", staff_model: { key: "qwen" } });
  });
});
