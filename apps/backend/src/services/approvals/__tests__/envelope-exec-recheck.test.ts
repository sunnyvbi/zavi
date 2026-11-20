import { describe, expect, it, vi } from "vitest";
import { envelopeLaunchSwitchedOff, founderEnvelopeApprovedAction, founderEnvelopeVerdict } from "@/services/approvals/envelope-door";
import { buildEnvelope, verifyEnvelope, type ApprovalEnvelope } from "@/services/approvals/approval-envelope";

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plan = { channel_slug: "google_ads", budget_type: "daily" as const, total_usd: 100, daily_usd: 10, start: today, end: plus(3), days: 3, switched_from: null };
const ENV: ApprovalEnvelope = buildEnvelope({ envelope_id: "ask:run-1", tenant_id: T, approver: { user_id: OWNER, role: "owner", surface: "chat" }, plan });

describe("envelopeLaunchSwitchedOff", () => {
  it("refuses an envelope-approved create once the switch is off; never reads for other classes", async () => {
    const read = vi.fn(async () => ENV);
    expect(await envelopeLaunchSwitchedOff({ tenant_id: T, exec_class: "google_ads.create_campaign" }, "a1", { readEnvelope: read, enabled: async () => false })).toBe(true);
    expect(await envelopeLaunchSwitchedOff({ tenant_id: T, exec_class: "google_ads.create_campaign" }, "a1", { readEnvelope: read, enabled: async () => true })).toBe(false);
    expect(await envelopeLaunchSwitchedOff({ tenant_id: T, exec_class: "google_ads.create_campaign" }, "a1", { readEnvelope: async () => null, enabled: async () => false })).toBe(false);
    read.mockClear();
    expect(await envelopeLaunchSwitchedOff({ tenant_id: T, exec_class: "google_ads.update_campaign_budget" }, "a1", { readEnvelope: read, enabled: async () => false })).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it("an unreadable envelope on a create class fails closed", async () => {
    expect(await envelopeLaunchSwitchedOff({ tenant_id: T, exec_class: "chatgpt_ads.create_and_launch" }, "a1", { readEnvelope: async () => { throw new Error("db"); }, enabled: async () => true })).toBe(true);
  });
});

describe("founderEnvelopeApprovedAction (the Google create switches on for a founder's direct ask)", () => {
  const d = { id: "a1", tenant_id: T, decision_class: "google_ads.create_campaign", body: { daily_budget_usd: 10, end_date: plus(3), location_ids: [2840] }, approved_by: OWNER, approved_by_source: null, exec_source: "channel_actions" };
  const deps = { readEnvelope: async () => ENV, enabled: async () => true, verify: (t: string, e: ApprovalEnvelope, c: string, p: unknown) => verifyEnvelope(t, e, c, p, async () => "owner") };
  it("true for the founder's own envelope approval that still fits", async () => {
    expect(await founderEnvelopeApprovedAction(d, "google_ads", deps)).toBe(true);
  });
  it("false for Autopilot, a decisions row, another approver, another channel, switch off, a demoted actor, or a create over the ask", async () => {
    expect(await founderEnvelopeApprovedAction({ ...d, approved_by_source: "cgo" }, "google_ads", deps)).toBe(false);
    expect(await founderEnvelopeApprovedAction({ ...d, exec_source: undefined as never }, "google_ads", deps)).toBe(false);
    expect(await founderEnvelopeApprovedAction({ ...d, approved_by: "someone-else" }, "google_ads", deps)).toBe(false);
    expect(await founderEnvelopeApprovedAction(d, "meta_ads", deps)).toBe(false);
    expect(await founderEnvelopeApprovedAction(d, "google_ads", { ...deps, enabled: async () => false })).toBe(false);
    expect(await founderEnvelopeApprovedAction(d, "google_ads", { ...deps, verify: (t, e, c, p) => verifyEnvelope(t, e, c, p, async () => "member") })).toBe(false);
    expect(await founderEnvelopeApprovedAction({ ...d, body: { daily_budget_usd: 20, end_date: plus(3), location_ids: [2840] } }, "google_ads", deps)).toBe(false);
    expect(await founderEnvelopeApprovedAction(d, "google_ads", { ...deps, readEnvelope: async () => null })).toBe(false);
  });
});

describe("founderEnvelopeVerdict: read before the create", () => {
  const d = { id: "a1", tenant_id: T, decision_class: "google_ads.create_campaign", body: { daily_budget_usd: 10, end_date: plus(3), location_ids: [2840] }, approved_by: OWNER, approved_by_source: null, exec_source: "channel_actions" };
  const ok = { readEnvelope: async () => ENV, enabled: async () => true, verify: (t: string, e: ApprovalEnvelope, c: string, p: unknown) => verifyEnvelope(t, e, c, p, async () => "owner") };
  it("valid / none / invalid", async () => {
    expect(await founderEnvelopeVerdict(d, "google_ads", ok)).toBe("valid");
    expect(await founderEnvelopeVerdict({ ...d, approved_by_source: "cgo" }, "google_ads", ok)).toBe("none");
    expect(await founderEnvelopeVerdict(d, "google_ads", { ...ok, readEnvelope: async () => null })).toBe("none");
    expect(await founderEnvelopeVerdict({ ...d, approved_by: "someone-else" }, "google_ads", ok)).toBe("none");
    expect(await founderEnvelopeVerdict(d, "google_ads", { ...ok, verify: (t, e, c, p) => verifyEnvelope(t, e, c, p, async () => "member") })).toBe("invalid");
    expect(await founderEnvelopeVerdict({ ...d, body: { ...d.body, daily_budget_usd: 20 } }, "google_ads", ok)).toBe("invalid");
    expect(await founderEnvelopeVerdict(d, "google_ads", { ...ok, enabled: async () => false })).toBe("invalid");
    expect(await founderEnvelopeVerdict(d, "google_ads", { ...ok, readEnvelope: async () => { throw new Error("db"); } })).toBe("invalid");
  });
});

describe("a Google direct ask with no place to run is the normal card", () => {
  it("the door never mints an envelope for a create with no location", async () => {
    const { envelopeDoor } = await import("@/services/approvals/envelope-door");
    const approve = vi.fn(async () => ({ ok: true }));
    const claim = vi.fn(async () => ({ ok: true }));
    const ask = { approver: { user_id: OWNER, role: "owner" as const, surface: "chat" as const }, envelope_id: "ask:run-1", ask: { channel_slug: "google_ads", total_usd: 100, daily_usd: 10, days: 3 }, shape: { kind: "plan" as const, plan, line: "x", reshaped: false } };
    const input = { tenantId: T, runId: "run-1", execClass: "google_ads.create_campaign", execPayload: { daily_budget_usd: 10, end_date: plus(3), location_ids: [] } };
    const r = await envelopeDoor(input, "act-1", { enabled: async () => true, readEnvelope: async () => null, readFounderAsk: async () => ask, claim, approve, send: async () => undefined });
    expect(r).toEqual({ approved: false, reason: "create_not_the_ask" });
    expect(claim).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    const withPlace = { ...input, execPayload: { ...input.execPayload, location_ids: [2840] } };
    const ok = await envelopeDoor(withPlace, "act-2", { enabled: async () => true, readEnvelope: async () => null, readFounderAsk: async () => ask, claim, approve, setEnvelope: async () => ({ ok: true }), verify: (t, e, c, p) => verifyEnvelope(t, e, c, p, async () => "owner"), send: async () => undefined, supersede: async () => ({ ok: true }) });
    expect(ok.approved).toBe(true);
  });
});
