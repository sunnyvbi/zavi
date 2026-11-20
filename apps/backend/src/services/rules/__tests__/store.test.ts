import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => rpc(...a),
}));

import { addRule, deleteRule, RuleError } from "../store";

beforeEach(() => rpc.mockReset());

const add = () =>
  addRule("t1", "u1", { text: "x", scope_kind: "agent", scope_slug: "operator", origin: "feedback_command" });

describe("rules store", () => {
  it("passes the actor and never a tenant (tenantRpc injects it); 'all' scope drops the slug", async () => {
    rpc.mockResolvedValue({ data: { status: "active", rule_id: "r1" }, error: null });
    await addRule("t1", "u1", { text: "No TikTok", scope_kind: "all", scope_slug: "ignored", origin: "rules_page" });
    const [tid, fn, args] = rpc.mock.calls[0]!;
    expect(tid).toBe("t1");
    expect(fn).toBe("rule_add");
    expect(args).toMatchObject({ p_actor: "u1", p_text: "No TikTok", p_scope_kind: "all", p_scope_slug: null, p_origin: "rules_page" });
    expect(args).not.toHaveProperty("p_tenant_id");
  });

  it.each([
    [{ message: "rules: only an owner or admin can do this", code: "42501" }, "forbidden", "Only an owner or admin can do this"],
    [{ message: "rules: this company already has 30 active rules; delete one first", code: "P0001", hint: "rule_cap" }, "cap", "This company already has 30 active rules; delete one first"],
    [{ message: "rules: this looks like a card or ID number, which cannot be saved in a rule", code: "22023", hint: "sensitive_number" }, "sensitive", "This looks like a card or ID number, which cannot be saved in a rule"],
    [{ message: "rules: a rule can be at most 280 characters", code: "22023" }, "invalid", "A rule can be at most 280 characters"],
    [{ message: "connection reset by peer" }, "failed", "Something went wrong saving the rule."],
  ])("maps %j to a %s RuleError with a founder-readable message", async (err, code, message) => {
    rpc.mockResolvedValue({ data: null, error: err });
    const e = await add().catch((x) => x);
    expect(e).toBeInstanceOf(RuleError);
    expect(e.code).toBe(code);
    expect(e.message).toBe(message);
  });

  it("an internal database message never reaches the founder", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'relation "tenant_rules" does not exist' } });
    const e = await deleteRule("t1", "u1", "r1").catch((x) => x);
    expect(e.message).not.toMatch(/relation|tenant_rules/);
  });
});
