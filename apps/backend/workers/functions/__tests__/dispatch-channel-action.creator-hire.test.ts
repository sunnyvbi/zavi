import { describe, it, expect, vi, beforeEach } from "vitest";

const sb = vi.hoisted(() => ({ blob: {} as Record<string, unknown> }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { blob: sb.blob }, error: null }) }) }) }),
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: vi.fn(async () => false) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({ id: "dispatch-channel-action" }), send: vi.fn() } }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: vi.fn(async () => null), planIncludesChannel: vi.fn(async () => true) }));

import { runChannelActionMutation, type ExecHandler } from "../dispatch-channel-action";
import { platformWriteEnabled } from "@/services/channels/exec-kill-switch";
import { approveCreatorHire } from "@/services/creators/hire-approve";
import { ExpectedToolError } from "@/services/tools/types";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTION = "99999999-9999-4999-8999-999999999999";

function claimed(over: Record<string, unknown> = {}) {
  return async () => ({
    ok: true as const,
    row: {
      claim_id: "claim-1",
      tenant_id: TENANT,
      channel_slug: "ugc",
      exec_class: "creator.hire",
      exec_payload: { order_id: "22222222-2222-4222-8222-222222222222", caps_id: "44444444-4444-4444-8444-444444444444" },
      approved_by: "aaaaaaaa-0000-4000-8000-000000000001",
      approved_by_source: null,
      agent_run_id: "r1",
      ...over,
    },
  });
}

beforeEach(() => {
  sb.blob = {};
});

describe("creator.hire on the rail", () => {
  it("switch OFF by default (test 10): refused before the handler, nothing charged", async () => {
    const handler = vi.fn();
    const out = await runChannelActionMutation(ACTION, {
      claim: claimed(),
      writeEnabled: platformWriteEnabled,
      loadHandler: async () => handler as unknown as ExecHandler,
    });
    expect(out.outcome.skipped).toBe("kill_switch");
    expect(out.settle?.result).toMatchObject({ kill_switch: true, platform: "creator" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("switch ON reaches the handler", async () => {
    sb.blob = { creator_hires_enabled: true };
    const handler = vi.fn(async () => ({ ok: true, notice: "Hired." }));
    const out = await runChannelActionMutation(ACTION, {
      claim: claimed(),
      writeEnabled: platformWriteEnabled,
      loadHandler: async () => handler as unknown as ExecHandler,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(out.settle).toMatchObject({ ok: true });
  });

  it("a CGO approval (test 14) is refused by the real handler before anything moves", async () => {
    sb.blob = { creator_hires_enabled: true };
    const out = await runChannelActionMutation(ACTION, {
      claim: claimed({ approved_by_source: "cgo" }),
      writeEnabled: platformWriteEnabled,
      loadHandler: async () => ((d) => approveCreatorHire(d as never)) as ExecHandler,
    });
    expect(out.settle).toMatchObject({ ok: false, result: { code: "creator_hire_founder_only" } });
  });

  it("a Checkout fallback puts the link on the card", async () => {
    sb.blob = { creator_hires_enabled: true };
    const out = await runChannelActionMutation(ACTION, {
      claim: claimed(),
      writeEnabled: platformWriteEnabled,
      loadHandler: async () => (async () => ({ ok: false, code: "creator_hire_checkout", error: "Pay with the link.", checkout_url: "https://checkout.stripe/cs_1" })) as ExecHandler,
    });
    expect(out.settle?.result).toEqual({ error: "Pay with the link.", code: "creator_hire_checkout", checkout_url: "https://checkout.stripe/cs_1" });
  });
});

describe("a budget release that did not land is retried by Inngest, not settled dead", () => {
  function hireWorld() {
    const reservations = new Map<string, "held" | "released">();
    let settleFails = 1;
    const deps = {
      roleFor: async () => "owner",
      writeEnabled: async () => true,
      loadOrder: async () => ({ id: "22222222-2222-4222-8222-222222222222", tenant_id: TENANT, status: "checkout_pending", business_total_cents: 16_500, livemode: false, stripe_checkout_session_id: null, stripe_payment_intent_id: null, package_snapshot: { creator_country_code: "US" } }),
      reserve: async (_t: string, a: { order_id: string; amount_usd: number }) => {
        const row = reservations.get(a.order_id);
        if (row === "held") return { status: "already_held", amount_usd: a.amount_usd, state: "held" };
        reservations.set(a.order_id, "held");
        return { status: "reserved", amount_usd: a.amount_usd, left_usd: 100 };
      },
      settle: async (_t: string, order_id: string) => {
        if (settleFails > 0) { settleFails -= 1; return { status: "unavailable", error: "db down" }; }
        reservations.set(order_id, "released");
        return { status: "released", changed: true };
      },
      loadWallet: async () => null,
      hold: async () => {
        throw new ExpectedToolError("creator_payout_country_unsupported", "Payouts to this creator's country are not supported yet.");
      },
      resumeCheckout: async () => ({ order_id: "o", checkout_url: "https://checkout.stripe/cs_1" }),
    };
    return { reservations, handler: ((d) => approveCreatorHire(d as never, deps as never)) as ExecHandler };
  }

  it("attempt 1 hands the claim back and throws; attempt 2 releases and refuses; one reservation", async () => {
    sb.blob = { creator_hires_enabled: true };
    const w = hireWorld();
    const releaseClaim = vi.fn(async () => true);
    const base = { writeEnabled: platformWriteEnabled, loadHandler: async () => w.handler, releaseClaim };
    await expect(runChannelActionMutation(ACTION, { ...base, claim: claimed() }, { retryable: true })).rejects.toMatchObject({ code: "creator_hire_release_pending" });
    expect(releaseClaim).toHaveBeenCalledWith(ACTION, "claim-1");
    expect(w.reservations.get("22222222-2222-4222-8222-222222222222")).toBe("held");

    const second = await runChannelActionMutation(ACTION, { ...base, claim: claimed({ claim_id: "claim-2" }) }, { retryable: true });
    expect(second.settle?.result).toMatchObject({ code: "creator_payout_country_unsupported" });
    expect(w.reservations.size).toBe(1);
    expect(w.reservations.get("22222222-2222-4222-8222-222222222222")).toBe("released");
  });

  it("on the last attempt it settles failed (retryable, Approve open) instead of leaving the row queued", async () => {
    sb.blob = { creator_hires_enabled: true };
    const w = hireWorld();
    const releaseClaim = vi.fn(async () => true);
    const out = await runChannelActionMutation(ACTION, { claim: claimed(), writeEnabled: platformWriteEnabled, loadHandler: async () => w.handler, releaseClaim }, { retryable: false });
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(out.settle).toMatchObject({ ok: false, result: { code: "creator_hire_release_pending" } });
  });

  it("if the claim cannot be handed back it settles failed rather than throwing", async () => {
    sb.blob = { creator_hires_enabled: true };
    const w = hireWorld();
    const out = await runChannelActionMutation(ACTION, { claim: claimed(), writeEnabled: platformWriteEnabled, loadHandler: async () => w.handler, releaseClaim: async () => false }, { retryable: true });
    expect(out.settle).toMatchObject({ ok: false, result: { code: "creator_hire_release_pending" } });
  });
});
