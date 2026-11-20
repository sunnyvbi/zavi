import { describe, it, expect, vi, beforeEach } from "vitest";

const updates = vi.hoisted(() => [] as unknown[][]);
const stamp = vi.hoisted(() => ({ fail: false }));
const replyText = vi.hoisted(() => vi.fn(async () => null as string | null));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => ({
      update: (row: unknown) => ({
        eq: (col: string, v: unknown) => ({
          select: () => {
            updates.push([table, row, col, v]);
            return Promise.resolve(stamp.fail ? { data: [], error: null } : { data: [{ id: v }], error: null });
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/services/agents/email-reply-trust", () => ({ emailReplyOwnText: () => replyText() }));

import { applyRulesToRun } from "../apply";
import type { AgentContext } from "@/services/agents/types";

const RULES = {
  rules: [{ id: "r1", scope_kind: "all" as const, scope_slug: null, text: "Always cut ad sets under 1% CTR", approved_at: null }],
  hash: "h".repeat(64),
};
const ctxOf = (over: Partial<AgentContext>) => ({ tenant_id: "t1", runId: "run-1", ...over }) as AgentContext;

beforeEach(() => {
  stamp.fail = false;
  updates.length = 0;
  replyText.mockResolvedValue(null);
});

describe("applyRulesToRun", () => {
  it("no rules: touches nothing (acceptance 12)", async () => {
    const ctx = ctxOf({ trigger: "chat" });
    await applyRulesToRun(ctx, { current_message: "how are my ads doing?" }, { rules: [], hash: null });
    expect(ctx.rules_steered).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it("chat question + rules: steered, and the rule-set hash is stamped (acceptance 5, 11)", async () => {
    const ctx = ctxOf({ trigger: "chat" });
    await applyRulesToRun(ctx, { current_message: "how are my ads doing?" }, RULES);
    expect(ctx.rules_steered).toEqual({ budget: true, status: true });
    expect(updates).toEqual([["agent_runs", { rule_set_hash: RULES.hash }, "id", "run-1"]]);
  });

  it("chat command + rules: not steered, the founder's command stands", async () => {
    const ctx = ctxOf({ trigger: "chat" });
    await applyRulesToRun(ctx, { current_message: "cut the budget on the weak ones now" }, RULES);
    expect(ctx.rules_steered).toEqual({ budget: false, status: true });
  });

  it("a handoff child of a chat is judged on the founder's own words", async () => {
    const asked = ctxOf({ trigger: "handoff" });
    await applyRulesToRun(asked, { current_user_text_raw: "Raise the Google budget to $80" }, RULES);
    expect(asked.rules_steered).toEqual({ budget: false, status: true });
    const report = ctxOf({ trigger: "handoff" });
    await applyRulesToRun(report, { current_user_text_raw: "Show me Google performance" }, RULES);
    expect(report.rules_steered).toEqual({ budget: true, status: true });
  });

  it("verified email reply reads the founder's own words", async () => {
    replyText.mockResolvedValue("Raise the LA budget to $80");
    const ctx = ctxOf({ trigger: "email", verified_member_email_reply: true });
    await applyRulesToRun(ctx, {}, RULES);
    expect(ctx.rules_steered).toEqual({ budget: false, status: true });
  });

  it("verified email reply whose text cannot be read counts as not asking (fail closed)", async () => {
    replyText.mockRejectedValue(new Error("db down"));
    const ctx = ctxOf({ trigger: "email", verified_member_email_reply: true });
    await applyRulesToRun(ctx, {}, RULES);
    expect(ctx.rules_steered).toEqual({ budget: true, status: true });
  });

  it("scheduled / channel runs are left exactly as they were (already agent-initiated)", async () => {
    const ctx = ctxOf({ trigger: "channel_recipe" as AgentContext["trigger"] });
    await applyRulesToRun(ctx, {}, RULES);
    expect(ctx.rules_steered).toBeUndefined();
    expect(updates.length).toBe(1);
  });
});

describe("applyRulesToRun: no audit stamp, no rules", () => {
  it("returns true only when the rule-set hash landed on the run", async () => {
    expect(await applyRulesToRun(ctxOf({ trigger: "chat" }), { current_message: "hi" }, RULES)).toBe(true);
    stamp.fail = true;
    const ctx = ctxOf({ trigger: "chat" });
    expect(await applyRulesToRun(ctx, { current_message: "how are my ads?" }, RULES)).toBe(false);
    expect(ctx.rules_steered).toBeUndefined();
  });

  it("no rules → false and no write", async () => {
    expect(await applyRulesToRun(ctxOf({ trigger: "chat" }), {}, { rules: [], hash: null })).toBe(false);
    expect(updates).toEqual([]);
  });
});
