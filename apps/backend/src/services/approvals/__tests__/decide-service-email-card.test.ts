import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: {
    row: null as Record<string, unknown> | null,
    rpcError: null as { message: string } | null,
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcError ? { data: null, error: state.rpcError } : { data: { changed: true, status: "approved" }, error: null });
    },
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn().mockResolvedValue("owner") }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));

const tier = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: tier.check,
}));

const card = vi.hoisted(() => ({ approve: vi.fn() }));
vi.mock("@/services/email-cards/cards", async (orig) => ({
  ...(await orig<typeof import("@/services/email-cards/cards")>()),
  approveEmailCard: card.approve,
}));

import { decideOnDecision } from "../decide-service";
import { EMAIL_CARD_APPROVE_MESSAGE } from "@/services/email-cards/approve-gate";

const row = (decision_class: string) => ({ id: "d-1", tenant_id: "t-1", status: "proposed", decision_class, agent_run_id: null, body: {} });

beforeEach(() => {
  rpcCalls.length = 0;
  state.rpcError = null;
  card.approve.mockReset();
  tier.check.mockReset();
  tier.check.mockResolvedValue({ allowed: true });
});

describe("decideOnDecision: email send classes", () => {
  for (const cls of ["email_campaign.create_and_send", "bulk_outbound.send"]) {
    it(`refuses a direct approve of ${cls} before any flip, on every source`, async () => {
      state.row = row(cls);
      for (const extra of [{}, { staff_override: true }, { approver_source: "cgo" as const }]) {
        const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, ...extra });
        expect(r).toMatchObject({ ok: false, code: "email_card_required", changed: false, detail: EMAIL_CARD_APPROVE_MESSAGE });
      }
      expect(rpcCalls).toHaveLength(0);
    });

    it(`still lets anyone reject ${cls}`, async () => {
      state.row = row(cls);
      const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "reject", actor: { user_id: "u-owner" } });
      expect(r.ok).toBe(true);
      expect(rpcCalls.map((c) => c.fn)).toEqual(expect.arrayContaining(["decide_decision_as_actor"]));
    });
  }

  it("maps the SQL trigger's refusal to email_card_required", async () => {
    state.row = row("support-lead.reply");
    state.rpcError = { message: "email_card_approve_required: an email send is approved only from its email card" };
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" } });
    expect(r).toMatchObject({ ok: false, code: "email_card_required", detail: EMAIL_CARD_APPROVE_MESSAGE });
  });

  it("other classes approve as before", async () => {
    state.row = row("support-lead.reply");
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" } });
    expect(r).toMatchObject({ ok: true, changed: true });
  });

  it("without a picked version (Slack, chat, bulk) the refusal carries the card link", async () => {
    state.row = row("bulk_outbound.send");
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" } });
    expect(r).toMatchObject({ ok: false, code: "email_card_required" });
    const link = new URL(String((r as { open_in_zavi?: string }).open_in_zavi));
    expect(link.pathname).toBe("/workspace/email-cards/decisions/d-1");
    expect(link.searchParams.get("company")).toBe("t-1");
    expect(card.approve).not.toHaveBeenCalled();
  });

  it("the web card's picked version goes through the email card approve, never the generic flip", async () => {
    state.row = row("email_campaign.create_and_send");
    card.approve.mockResolvedValueOnce({ ok: true, queued: true, changed: true });
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, email_variant: 2, request_id: "req-12345678" });
    expect(r).toMatchObject({ ok: true, changed: true, status: "approved" });
    expect(card.approve).toHaveBeenCalledWith("t-1", "decisions", "d-1", 2, "u-owner", "req-12345678");
    expect(rpcCalls).toHaveLength(0);
  });

  it("a picked version still needs the card's own checks: no test, not an approver; staff and cgo never pass one", async () => {
    state.row = row("bulk_outbound.send");
    card.approve.mockResolvedValueOnce({ ok: false, code: "test_required" });
    expect(await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, email_variant: 1 })).toMatchObject({
      ok: false,
      code: "email_card_required",
      email_card_code: "test_required",
    });
    card.approve.mockResolvedValueOnce({ ok: false, code: "not_authorized" });
    expect(await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-member" }, email_variant: 1 })).toMatchObject({
      ok: false,
      code: "not_authorized",
    });
    card.approve.mockClear();
    for (const extra of [{ staff_override: true }, { approver_source: "cgo" as const }]) {
      const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, email_variant: 1, ...extra });
      expect(r).toMatchObject({ ok: false, code: "email_card_required" });
    }
    expect(card.approve).not.toHaveBeenCalled();
  });

  it("the card's picked version on a plan without email sending is refused with the upgrade answer, before the card approve or any RPC", async () => {
    state.row = row("bulk_outbound.send");
    tier.check.mockResolvedValue({ allowed: false, required_tier: "pro" });
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, email_variant: 1, request_id: "req-12345678" });
    expect(r).toMatchObject({ ok: false, code: "plan_required", changed: false, status: "proposed" });
    expect(r.plan_refusal).toMatchObject({ status: 403, body: { error: { code: "plan_upgrade_required", required_tier: "pro" } } });
    expect(tier.check).toHaveBeenCalledWith("t-1", "email_marketing");
    expect(card.approve).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("a plan that cannot be read refuses the card's picked version too, fail closed", async () => {
    state.row = row("email_campaign.create_and_send");
    for (const mock of [() => tier.check.mockRejectedValue(new Error("db down")), () => tier.check.mockResolvedValue({ allowed: true, unverified: true })]) {
      mock();
      const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, email_variant: 2, request_id: "req-12345678" });
      expect(r).toMatchObject({ ok: false, code: "plan_required", plan_refusal: { status: 503, body: { error: { code: "plan_unreadable" } } } });
    }
    expect(card.approve).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });
});
