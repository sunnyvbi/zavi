import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ emit: vi.fn(), live: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: async () => null }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: async () => true }));
vi.mock("@/services/connectors/linkedin-ads/write", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/services/connectors/linkedin-ads/write")>()), readLinkedInRawCampaign: m.live }));

import { linkedinAdsProposeResumeCampaignTool } from "../write/propose_resume_campaign";
import { isFounderRequested } from "@/services/growth/cgo-ads";
import { evaluateUnattended } from "@/services/growth/unattended-policy";

const input = { campaign_id: "22", account_id: "11", rationale: "It booked demos at a fair cost before it stopped." };
const run = (ctx: Record<string, unknown>) => linkedinAdsProposeResumeCampaignTool.execute({ tenant_id: "t1", run_id: "r1", log: () => {}, emit_decision: m.emit, ...ctx } as never, input);
const filed = () => m.emit.mock.calls[0][1] as Record<string, unknown>;
const facts = { refsResolved: true, openAdvice: "clear" as const, goal: { present: false as const }, channelAutorun: true, spendUpUnderBudget: true, trackingOk: true, pausedByFounder: false, linkedinAd: { available: true, wallet: false, accountInUse: true, liveTouchedSinceZavi: false, consent: true } };
const verdictFor = () => evaluateUnattended({ kind: "ad", exec_class: "linkedin_ads.resume_campaign", payload: filed(), source: { table: "channel_actions", id: "ca-1", run_id: "r1" } }, facts).verdict;

beforeEach(() => {
  m.emit.mockReset().mockResolvedValue("ca-1");
  m.live.mockReset().mockResolvedValue({ id: 22, name: "Spring", status: "PAUSED", dailyBudget: { amount: "40", currencyCode: "USD" }, runSchedule: { start: Date.now() - 86_400_000, end: Date.now() + 30 * 86_400_000 } });
});

describe("a LinkedIn card says who asked for it, so the cgo door never answers the founder's own order", () => {
  it("a channel run's own proposal is stamped agent, and the gate may approve it", async () => {
    await run({ run_trigger: "scheduled" });
    expect(filed().origin).toBe("agent");
    expect(isFounderRequested(filed())).toBe(false);
    expect(verdictFor()).toBe("allow");
  });

  it("must catch: the founder's chat order is stamped user_initiated_chat, and neither the door nor the gate approves it", async () => {
    await run({ run_trigger: "chat", founder_chat_order: true });
    expect(filed().origin).toBe("user_initiated_chat");
    expect(isFounderRequested(filed())).toBe(true);
    expect(verdictFor()).toBe("deny");
  });

  it("must catch: a human-typed chat turn, a verified email reply and a top-action press are the founder's", async () => {
    for (const ctx of [{ run_trigger: "chat" }, { run_trigger: "email", verified_member_email_reply: true }, { run_trigger: "scheduled", top_action_run: true }]) {
      m.emit.mockClear();
      await run(ctx);
      expect([ctx, filed().origin]).toEqual([ctx, "user_initiated_chat"]);
    }
  });

  it("a chat turn carrying untrusted page text is not the founder's words: stamped agent", async () => {
    await run({ run_trigger: "chat", untrusted_context: true });
    expect(filed().origin).toBe("agent");
  });
});
