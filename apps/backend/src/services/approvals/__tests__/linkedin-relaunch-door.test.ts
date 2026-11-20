import { describe, expect, it, vi } from "vitest";
import { envelopeDoor } from "../envelope-door";

const LAUNCH = "linkedin_ads.launch_campaign";
const payload = { campaign_binding_id: "11111111-1111-4111-8111-111111111111", total_budget_usd: 200, currency: "USD", end_time: Date.now() + 14 * 86_400_000 };
const founderAsk = { approver: { user_id: "u1" }, envelope_id: "ask:r1", shape: { kind: "plan", plan: { total_usd: 200 } }, ask: { channel_slug: "linkedin_ads", total_usd: 200, daily_usd: null, days: 14 } };

function deps(ever: () => Promise<boolean>) {
  return {
    enabled: async () => true,
    linkedinEverRan: vi.fn(ever),
    readEnvelope: vi.fn(async () => ({ envelope_id: "ask:r1", actor_user_id: "u1", tenant_id: "t", channel: "linkedin_ads" })),
    readFounderAsk: vi.fn(async () => founderAsk),
    verify: vi.fn(async () => ({ ok: true })),
    claim: vi.fn(async () => ({ ok: true })),
    setEnvelope: vi.fn(async () => ({ ok: true })),
    supersede: vi.fn(async () => ({ ok: true })),
    approve: vi.fn(async () => ({ ok: true, attempt: 1 })),
    send: vi.fn(async () => undefined),
  };
}
const door = (d: ReturnType<typeof deps>, execClass = LAUNCH, execPayload: Record<string, unknown> = payload) =>
  envelopeDoor({ tenantId: "t", runId: "r1", execClass, execPayload }, "act-1", d as never);

describe("a typed ad request and a campaign that already ran", () => {
  it("a campaign that ran or was paused leaves a card: no envelope claimed, no approval, nothing sent", async () => {
    const d = deps(async () => true);
    expect(await door(d)).toEqual({ approved: false, reason: "relaunch_needs_card" });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.supersede).not.toHaveBeenCalled();
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("an unreadable history leaves a card", async () => {
    const d = deps(async () => { throw new Error("read failed"); });
    expect((await door(d)).approved).toBe(false);
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("a campaign with no binding id leaves a card", async () => {
    const d = deps(async () => false);
    expect((await door(d, LAUNCH, { ...payload, campaign_binding_id: undefined })).approved).toBe(false);
  });

  it("a campaign that never ran still takes the no-card launch", async () => {
    const d = deps(async () => false);
    expect(await door(d)).toMatchObject({ approved: true, actor_user_id: "u1" });
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("another channel's create never reads LinkedIn history", async () => {
    const d = deps(async () => true);
    await door(d, "meta_ads.create_campaign");
    expect(d.linkedinEverRan).not.toHaveBeenCalled();
  });
});
