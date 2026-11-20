import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ value: null as Record<string, unknown> | null, role: "owner" as string | null, on: true }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => env.on }));
vi.mock("@/services/approvals/approval-envelope", () => ({ readApprovalEnvelope: async () => env.value }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => env.role }));

import { founderEnvelopeCovers } from "@/services/approvals/envelope-door";

const T = "t1";
const D = { id: "card-1", tenant_id: T, approved_by: "u1", approved_by_source: null };
beforeEach(() => {
  env.value = { v: 1, envelope_id: "q:q1", tenant_id: T, actor_user_id: "u1", actor_role: "owner", surface: "cgo_yes", channel: "chatgpt_ads", max_total_usd: 58, max_daily_usd: null, starts_on: "2026-10-15", ends_on: "2026-10-17" };
  env.role = "owner";
  env.on = true;
});

describe("founderEnvelopeCovers", () => {
  it("the founder-approved card with a matching envelope is covered", async () => {
    expect(await founderEnvelopeCovers(D, "chatgpt_ads")).toBe(true);
  });
  it("a cgo approval, another approver, another channel, another tenant, a demoted actor, or the switch off is not", async () => {
    expect(await founderEnvelopeCovers({ ...D, approved_by_source: "cgo" }, "chatgpt_ads")).toBe(false);
    expect(await founderEnvelopeCovers({ ...D, approved_by: "u2" }, "chatgpt_ads")).toBe(false);
    expect(await founderEnvelopeCovers(D, "tiktok_ads")).toBe(false);
    env.value = { ...env.value!, tenant_id: "other" };
    expect(await founderEnvelopeCovers(D, "chatgpt_ads")).toBe(false);
    env.value = { ...env.value!, tenant_id: T };
    env.role = "member";
    expect(await founderEnvelopeCovers(D, "chatgpt_ads")).toBe(false);
    env.role = "owner";
    env.on = false;
    expect(await founderEnvelopeCovers(D, "chatgpt_ads")).toBe(false);
    env.on = true;
    env.value = null;
    expect(await founderEnvelopeCovers(D, "chatgpt_ads")).toBe(false);
  });
});
