import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { approveFromChatQuickPath } from "../chat-quick-approve";

const DECISION_ID = "66666666-6666-4666-8666-666666666666";
const TENANT = "77777777-7777-4777-8777-777777777777";

function svcReturning(row: unknown, error: { message: string } | null = null) {
  const eqs: Array<[string, unknown]> = [];
  type Chain = { select: () => Chain; eq: (k: string, v: unknown) => Chain; maybeSingle: () => Promise<unknown> };
  const chain: Chain = {
    select: vi.fn((): Chain => chain),
    eq: vi.fn((k: string, v: unknown): Chain => {
      eqs.push([k, v]);
      return chain;
    }),
    maybeSingle: vi.fn(async () => ({ data: row, error })),
  };
  return { svc: { from: vi.fn(() => chain) }, eqs };
}

function userClient(error: { message: string } | null = null) {
  return { rpc: vi.fn(async () => ({ error })) };
}

describe("approveFromChatQuickPath", () => {
  for (const cls of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
    it(`refuses ${cls} and never calls approve_decision`, async () => {
      const { svc } = svcReturning({ decision_class: cls, handler: "composio.execute_tool" });
      const uc = userClient();
      const r = await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT });
      expect(r).toEqual(expect.objectContaining({ ok: false, code: "composio_needs_card" }));
      expect(uc.rpc).not.toHaveBeenCalled();
    });
  }
  it.each([
    ["chatgpt_ads.create_and_launch", { name: "c" }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }],
    ["chatgpt_ads.set_status", { status: "ACTIVE" }],
    ["meta_ads.set_status", { status: "ACTIVE" }],
    ["tiktok_ads.set_status", { status: "ACTIVE" }],
  ])("refuses a spend-raising ad card (%s) and never calls approve_decision", async (cls, body) => {
    const { svc } = svcReturning({ decision_class: cls, handler: null, body });
    const uc = userClient();
    const r = await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT });
    expect(r).toEqual(expect.objectContaining({ ok: false, code: "spend_needs_card" }));
    expect(uc.rpc).not.toHaveBeenCalled();
  });
  it("still passes an ad pause through (any member may approve one)", async () => {
    const { svc } = svcReturning({ decision_class: "chatgpt_ads.set_status", handler: null, body: { status: "PAUSED" } });
    const uc = userClient();
    expect(await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT })).toEqual({ ok: true });
  });
  it("refuses a composio handler even under another class name", async () => {
    const { svc } = svcReturning({ decision_class: "something.else", handler: "composio.execute_tool" });
    const uc = userClient();
    const r = await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT });
    expect(r.ok).toBe(false);
    expect(uc.rpc).not.toHaveBeenCalled();
  });
  it("fails closed when the decision cannot be read", async () => {
    const { svc } = svcReturning(null, { message: "boom" });
    const uc = userClient();
    const r = await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT });
    expect(r).toEqual(expect.objectContaining({ ok: false, code: "decision_lookup_failed" }));
    expect(uc.rpc).not.toHaveBeenCalled();
  });
  it("fails closed when the decision is not in this tenant", async () => {
    const { svc } = svcReturning(null);
    const uc = userClient();
    const r = await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT });
    expect(r).toEqual(expect.objectContaining({ ok: false, code: "decision_lookup_failed" }));
    expect(uc.rpc).not.toHaveBeenCalled();
  });
  it("approves an engineer.ship-pr through the user's approve_decision RPC, tenant-scoped read", async () => {
    const { svc, eqs } = svcReturning({ decision_class: "engineer.ship-pr", handler: "github.open_pr" });
    const uc = userClient();
    const r = await approveFromChatQuickPath({ svc, userClient: uc, decision_id: DECISION_ID, tenant_id: TENANT });
    expect(r).toEqual({ ok: true });
    expect(uc.rpc).toHaveBeenCalledWith("approve_decision", { p_decision_id: DECISION_ID });
    expect(eqs).toEqual(expect.arrayContaining([["id", DECISION_ID], ["tenant_id", TENANT]]));
  });
  it("surfaces an RPC error as approve_failed", async () => {
    const { svc } = svcReturning({ decision_class: "engineer.ship-pr", handler: null });
    const r = await approveFromChatQuickPath({ svc, userClient: userClient({ message: "nope" }), decision_id: DECISION_ID, tenant_id: TENANT });
    expect(r).toEqual({ ok: false, code: "approve_failed", message: "nope" });
  });
});

describe("chat-send never calls approve_decision directly", () => {
  const src = readFileSync(join(__dirname, "../../../routes/agents/chat-send.ts"), "utf8");
  it("every chat approve goes through approveFromChatQuickPath", () => {
    expect(src).not.toMatch(/rpc\(\s*["']approve_decision["']/);
    expect((src.match(/approveFromChatQuickPath\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
