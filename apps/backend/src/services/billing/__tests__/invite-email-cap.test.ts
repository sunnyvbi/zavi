
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  blob: null as Record<string, unknown> | null,
  configError: null as { message: string } | null,
  sub: null as { tier: string | null; status: string | null; comp_expires_at: string | null } | null,
  subError: null as { message: string } | null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () =>
          table === "system_config"
            ? { data: db.configError ? null : { blob: db.blob }, error: db.configError }
            : { data: db.subError ? null : db.sub, error: db.subError },
      };
      return q;
    },
  }),
}));

import {
  DEFAULT_TIER_INVITE_EMAILS_PER_DAY,
  tierConfigRejection,
  tierInviteEmailsPerDayFromBlob,
} from "../tiers";
import { resolveInviteEmailCap } from "@/services/agents/entitlement";

beforeEach(() => {
  db.blob = null;
  db.configError = null;
  db.sub = null;
  db.subError = null;
});

describe("tierInviteEmailsPerDayFromBlob", () => {
  it("defaults to Free 3 / Starter 10 / Growth 25 / Pro 50", () => {
    expect(DEFAULT_TIER_INVITE_EMAILS_PER_DAY).toEqual({ free: 3, starter: 10, growth: 25, pro: 50 });
    expect(tierInviteEmailsPerDayFromBlob(null)).toEqual(DEFAULT_TIER_INVITE_EMAILS_PER_DAY);
  });

  it("takes a per-tier override and drops malformed or out-of-range entries per tier", () => {
    const caps = tierInviteEmailsPerDayFromBlob({
      tier_invite_emails_per_day: { free: 5, starter: "12", growth: 1001, pro: -1, bogus: 9 },
    });
    expect(caps).toEqual({ free: 5, starter: 12, growth: 25, pro: 50 });
    expect(tierInviteEmailsPerDayFromBlob({ tier_invite_emails_per_day: [1, 2] })).toEqual(DEFAULT_TIER_INVITE_EMAILS_PER_DAY);
  });

  it("the staff config PATCH validates the key", () => {
    expect(tierConfigRejection("tier_invite_emails_per_day", { free: 0, pro: 1000 })).toBeNull();
    expect(tierConfigRejection("tier_invite_emails_per_day", { free: 1001 })).toMatch(/0 to 1000/);
    expect(tierConfigRejection("tier_invite_emails_per_day", { enterprise: 5 })).toMatch(/must be one of/);
    expect(tierConfigRejection("tier_invite_emails_per_day", 10)).toMatch(/object/);
  });
});

describe("resolveInviteEmailCap", () => {
  it("no subscription -> Free -> 3", async () => {
    expect(await resolveInviteEmailCap("t1")).toEqual({ tier: "free", cap: 3, higherPlanAllowsMore: true });
  });

  it("an active Pro subscription -> 50, whatever tier_gate_enforced says", async () => {
    db.blob = { tier_gate_enforced: false };
    db.sub = { tier: "pro", status: "active", comp_expires_at: null };
    expect(await resolveInviteEmailCap("t1")).toEqual({ tier: "pro", cap: 50, higherPlanAllowsMore: false });
  });

  it("an unmapped or legacy tier -> the Free cap of 3", async () => {
    db.sub = { tier: "enterprise_legacy", status: "active", comp_expires_at: null };
    expect(await resolveInviteEmailCap("t1")).toMatchObject({ tier: "free", cap: 3 });
  });

  it("a canceled subscription -> Free", async () => {
    db.sub = { tier: "growth", status: "canceled", comp_expires_at: null };
    expect((await resolveInviteEmailCap("t1")).cap).toBe(3);
  });

  it("reads the override from system_config", async () => {
    db.blob = { tier_invite_emails_per_day: { starter: 15 } };
    db.sub = { tier: "starter", status: "active", comp_expires_at: null };
    expect(await resolveInviteEmailCap("t1")).toMatchObject({ tier: "starter", cap: 15 });
  });

  it("tier_pro_tenants forces Pro", async () => {
    db.blob = { tier_pro_tenants: ["t1"] };
    expect(await resolveInviteEmailCap("t1")).toMatchObject({ tier: "pro", cap: 50 });
  });

  it("fails safe to the LOWEST cap on a subscription read error", async () => {
    db.blob = { tier_invite_emails_per_day: { free: 4, starter: 2 } };
    db.subError = { message: "boom" };
    expect(await resolveInviteEmailCap("t1")).toEqual({ tier: "free", cap: 2, higherPlanAllowsMore: false });
  });

  it("fails closed on a config read error: throws, so no cap (and no default 3) is ever used", async () => {
    db.configError = { message: "boom" };
    db.sub = { tier: "pro", status: "active", comp_expires_at: null };
    await expect(resolveInviteEmailCap("t1")).rejects.toThrow(/system_config read failed/);
  });

  it("only hints at a higher plan when one really allows more", async () => {
    db.blob = { tier_invite_emails_per_day: { growth: 100, pro: 50 } };
    db.sub = { tier: "growth", status: "active", comp_expires_at: null };
    expect(await resolveInviteEmailCap("t1")).toEqual({ tier: "growth", cap: 100, higherPlanAllowsMore: false });
    db.sub = { tier: "starter", status: "active", comp_expires_at: null };
    expect((await resolveInviteEmailCap("t1")).higherPlanAllowsMore).toBe(true);
  });
});
