import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

const h = vi.hoisted(() => ({
  claims: new Map<string, string>(),
  previewSends: 0,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  staffCrossTenantClient: () => {
    throw new Error("not used: plan-ready deps are injected");
  },
  tenantClient: () => ({
    from: (table: string) => {
      const rows = table === "agent_runs" ? [{ agent_slug: "seo", status: "success", preview_action_types: ["fix"] }] : [{ name: "Acme" }];
      const chain = {
        select: () => chain,
        like: () => chain,
        eq: () => chain,
        limit: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async (key: string, t: string) => h.claims.has(`${t}:${key}`),
  getBoolSettingStrictResolved: async () => true,
  claimTenantFlag: async (t: string, key: string, by: string) => {
    await Promise.resolve();
    if (h.claims.has(`${t}:${key}`)) return false;
    h.claims.set(`${t}:${key}`, by);
    return true;
  },
  setTenantSetting: async (t: string, key: string, v: unknown) => {
    if (v === null) h.claims.delete(`${t}:${key}`);
  },
}));
vi.mock("../preview-plan", () => ({ planIncludesChannel: async () => false }));
vi.mock("@/email/sendAuthEmail", () => ({
  sendPreviewReadyEmail: async () => {
    h.previewSends++;
    return { sent: true };
  },
  sendPlanReadyEmail: vi.fn(),
  resolveSequenceRecipient: vi.fn(),
}));
vi.mock("@/services/web-base", () => ({ channelUrl: () => "https://app.test/c", growthPlanUrl: () => "", webBaseUrl: () => "" }));
vi.mock("@/services/onboarding-emails/sequence", () => ({ unsubscribeUrlFor: (t: string) => `https://api.test/unsub?t=${t}` }));
vi.mock("@/services/tenants/new-tenant-alert", () => ({ DOGFOOD_SLUGS: new Set<string>() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { maybeSendPreviewReadyEmail } from "../preview-ready-email";
import { maybeSendPlanReadyEmail, type PlanReadyDeps } from "../plan-ready-email";
import { claimTenantFlag, setTenantSetting } from "@/services/settings";
import { READY_EMAIL_CLAIM_KEY } from "../ready-email-claim";

function planDeps(): PlanReadyDeps & { sends: number } {
  const d = {
    sends: 0,
    tenantOfRun: async () => T,
    facts: async () => ({
      enabled: true,
      mailable: true,
      appliedPlans: 1,
      planOpened: false,
      owner: { user_id: "u1", optedOut: false, unsubToken: "tok" },
      company: "Acme",
    }),
    resolveRecipient: async () => ({ email: "owner@example.com", verified: true, name: "Dana" }),
    claim: (t: string) => claimTenantFlag(t, READY_EMAIL_CLAIM_KEY, "system:plan-ready-email"),
    release: async (t: string) => setTenantSetting(t, READY_EMAIL_CLAIM_KEY, null, "system:plan-ready-email"),
    send: async () => {
      d.sends++;
    },
    links: () => ({ planUrl: "https://app.test/plan", imageBaseUrl: "https://app.test" }),
  };
  return d;
}

beforeEach(() => {
  h.claims.clear();
  h.previewSends = 0;
});

describe("one ready email per workspace", () => {
  it("plan-ready sent first: the N-actions email skips", async () => {
    const plan = planDeps();
    expect(await maybeSendPlanReadyEmail("run-1", plan)).toEqual({ sent: true });
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "already_sent" });
    expect(plan.sends + h.previewSends).toBe(1);
  });

  it("N-actions sent first: the plan-ready email skips", async () => {
    const plan = planDeps();
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: true, total: 1 });
    expect(await maybeSendPlanReadyEmail("run-1", plan)).toEqual({ sent: false, reason: "already_claimed" });
    expect(plan.sends + h.previewSends).toBe(1);
  });

  it("both ready at the same moment: exactly one sends", async () => {
    const plan = planDeps();
    const [a, b] = await Promise.all([maybeSendPlanReadyEmail("run-1", plan), maybeSendPreviewReadyEmail(T)]);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
    expect(plan.sends + h.previewSends).toBe(1);
  });
});
