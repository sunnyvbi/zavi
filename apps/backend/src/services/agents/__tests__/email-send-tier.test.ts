import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  blob: {} as Record<string, unknown> | null,
  sub: null as { tier: string; status: string; comp_expires_at: string | null } | null,
  configError: null as string | null,
  subError: null as string | null,
  reads: [] as string[],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      db.reads.push(table);
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        maybeSingle: async () => {
          if (table === "system_config") return db.configError ? { data: null, error: { message: db.configError } } : { data: { blob: db.blob }, error: null };
          if (table === "tenant_subscriptions") return db.subError ? { data: null, error: { message: db.subError } } : { data: db.sub, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { checkAgentTier } from "@/services/agents/entitlement";
import { EMAIL_SEND_TIER_SLUG, emailSendTierRefusal, isEmailSendTool } from "@/services/agents/email-send-tier";

const T = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  db.blob = { tier_gate_enforced: true };
  db.sub = null;
  db.configError = null;
  db.subError = null;
  db.reads = [];
});

describe("which tool calls are email sends", () => {
  it.each([
    ["email", "propose_campaign"],
    ["email", "plan_send"],
    ["outbound", "propose_email"],
    ["outbound", "propose_cohort_email"],
    ["email_campaign", "propose_send"],
    ["email", "propose_anything_new"],
  ])("%s/%s is gated", (server, tool) => {
    expect(isEmailSendTool(server, tool)).toBe(true);
  });

  it.each([
    ["email", "send"],
    ["email", "list_inbox"],
    ["email", "get_thread"],
    ["email", "list_plan"],
    ["outbound", "list_email_lists"],
    ["email_campaign", "list_audiences"],
    ["email_campaign", "get_results"],
    ["slack", "propose_message"],
    ["meta_ads", "propose_new_ad_set"],
  ])("%s/%s is not an email send", (server, tool) => {
    expect(isEmailSendTool(server, tool)).toBe(false);
  });
});

describe("email send tools need the email_marketing plan, whichever agent calls them", () => {
  it("the QA case: with the tier gate on, a Free tenant may run growth-lead but may not propose an email through it", async () => {
    expect(await checkAgentTier(T, "growth-lead")).toMatchObject({ allowed: true, tier: "free" });
    const refusal = await emailSendTierRefusal(T);
    expect(refusal).toEqual({
      error: "plan_upgrade_required",
      required_tier: "pro",
      message: "Sending email needs the Pro plan ($240/mo). Tell the user they can upgrade on the Billing page.",
    });
  });

  it("the gate follows email_marketing's tier as configured, not a hard-coded Pro", async () => {
    db.blob = { tier_gate_enforced: true, tier_agent_min: { "growth-lead": "free", email_marketing: "starter" } };
    db.sub = { tier: "starter", status: "active", comp_expires_at: null };
    expect(await emailSendTierRefusal(T)).toBeNull();
    db.sub = null;
    expect(await emailSendTierRefusal(T)).toMatchObject({ error: "plan_upgrade_required", required_tier: "starter" });
  });

  it("deny by default: a map that forgets email_marketing needs Pro", async () => {
    db.blob = { tier_gate_enforced: true, tier_agent_min: { "growth-lead": "free" } };
    db.sub = { tier: "growth", status: "active", comp_expires_at: null };
    expect(await emailSendTierRefusal(T)).toMatchObject({ error: "plan_upgrade_required", required_tier: "pro" });
  });

  it("is gated even while tier_gate_enforced is off, exactly like the email_marketing channel itself", async () => {
    db.blob = { tier_gate_enforced: false };
    expect((await checkAgentTier(T, EMAIL_SEND_TIER_SLUG)).allowed).toBe(false);
    expect(await emailSendTierRefusal(T)).toMatchObject({ error: "plan_upgrade_required" });
  });

  it("a Pro tenant and a dogfood tenant on tier_pro_tenants may send", async () => {
    db.sub = { tier: "pro", status: "active", comp_expires_at: null };
    expect(await emailSendTierRefusal(T)).toBeNull();
    db.sub = null;
    db.blob = { tier_gate_enforced: true, tier_pro_tenants: [T] };
    expect(await emailSendTierRefusal(T)).toBeNull();
  });

  it("a lapsed Pro subscription and an expired comp are Free", async () => {
    db.sub = { tier: "pro", status: "canceled", comp_expires_at: null };
    expect(await emailSendTierRefusal(T)).toMatchObject({ error: "plan_upgrade_required" });
    db.sub = { tier: "pro", status: "active", comp_expires_at: new Date(Date.now() - 60_000).toISOString() };
    expect(await emailSendTierRefusal(T)).toMatchObject({ error: "plan_upgrade_required" });
  });

  it("fails closed when the plan config cannot be read (unverified is not allowed)", async () => {
    db.configError = "timeout";
    db.sub = { tier: "pro", status: "active", comp_expires_at: null };
    expect(await emailSendTierRefusal(T)).toEqual({
      error: "plan_unverified",
      message: "Zavi could not confirm this workspace's plan, so no email was proposed. Try again in a minute.",
    });
  });

  it("fails closed when the subscription cannot be read", async () => {
    db.subError = "connection reset";
    expect(await emailSendTierRefusal(T)).toMatchObject({ error: "plan_unverified" });
  });

  it("asks about the email_marketing slug, never the calling agent", async () => {
    const decide = vi.fn(async () => ({ enforced: true, tier: "free" as const, required_tier: "pro" as const, allowed: false }));
    await emailSendTierRefusal(T, decide);
    expect(decide).toHaveBeenCalledWith(T, "email_marketing");
  });
});
