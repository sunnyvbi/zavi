import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveChannelAction: vi.fn(async () => false) }));
vi.mock("@/services/growth/cgo-email", () => ({ cgoApproveEmailChannelAction: vi.fn(async () => false) }));

import { recordChannelExecAction } from "../exec-actions";

const off = { enabled: () => false, runMayAct: async () => true, log: vi.fn() };
const rpc = () => vi.fn(async (_tid: unknown, _fn: string, _args: { p_action: { exec_payload: Record<string, unknown>; body: Record<string, unknown> } }) => ({ data: { ok: true, id: "act-1", replayed: false }, error: null }));
const card = (execClass: string, channelSlug: string) => ({
  tenantId: "t-1",
  runId: "r-1",
  channelSlug,
  execClass,
  execPayload: { campaign_id: "c1", origin: "specialist", founder_chat_order: true, founder_order_unverified: true, move_group: "forged" },
  actionType: "update_ad" as const,
  title: "Raise the campaign",
  body: { step: { title: "Raise", body: "b" }, move_group: "forged", founder_chat_order: true },
});

describe("recordChannelExecAction and founder marks", () => {
  it("must-catch: a LinkedIn card carrying founder_chat_order from a tool is filed without any founder mark", async () => {
    const r = rpc();
    await recordChannelExecAction(card("linkedin_ads.update_campaign_budget", "linkedin_ads"), r as never, off);
    const sent = r.mock.calls[0][2].p_action;
    expect(sent.exec_payload).toEqual({ campaign_id: "c1", origin: "specialist" });
    expect(sent.body.founder_chat_order).toBeUndefined();
    expect(sent.body.move_group).toBeUndefined();
    expect(off.log).toHaveBeenCalledWith(expect.objectContaining({ code: "channel.founder_mark_rebuilt" }));
  });

  it("P2: a Meta/Google card's marks come only from the server state the seam passes, never from its payload", async () => {
    const r = rpc();
    await recordChannelExecAction(card("meta_ads.update_ad_set_budget", "meta_ads"), r as never, off);
    expect(r.mock.calls[0][2].p_action.exec_payload).toEqual({ campaign_id: "c1", origin: "specialist" });
    const r2 = rpc();
    await recordChannelExecAction({ ...card("meta_ads.update_ad_set_budget", "meta_ads"), serverFounder: { group: "root-1", unverified: false } }, r2 as never, off);
    expect(r2.mock.calls[0][2].p_action.exec_payload).toEqual({ campaign_id: "c1", origin: "user_initiated_chat", founder_chat_order: true, move_group: "root-1" });
  });
});
