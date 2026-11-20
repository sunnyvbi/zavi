
import { describe, it, expect, vi, beforeEach } from "vitest";

const stop = vi.hoisted(() => ({ value: false as boolean | null, calls: [] as string[][] }));
vi.mock("@/services/growth/channel-stopped", () => ({
  readChannelStopped: vi.fn(async (t: string, slug: string) => {
    stop.calls.push([t, slug]);
    return stop.value;
  }),
}));
const hold = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "held after the stop check"));
vi.mock("@/services/growth/move-group", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-group")>()),
  pairedDispatchHold: hold,
}));
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => false }));
const gads = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/tools/google-ads/write/update_campaign_budget", () => ({ googleUpdateCampaignBudget: gads }));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const row = {
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: "run-1",
  decision_class: "google_ads.update_campaign_budget",
  status: "dispatching",
  handler: null,
  body: { campaign_id: "9", daily_budget_usd: 50 },
  approved_by: "owner-1",
  approved_by_source: null,
};

beforeEach(() => {
  stop.value = false;
  stop.calls.length = 0;
  hold.mockClear();
  gads.mockClear();
});

describe("a stopped channel on the decision rail", () => {
  it("must-catch: an approved Google budget change on a stopped channel is refused before any platform call", async () => {
    stop.value = true;
    const r = await HANDLERS["google_ads.update_campaign_budget"]({ ...row });
    expect(r).toMatchObject({ ok: false, code: "founder_stopped" });
    expect(stop.calls).toEqual([["t-1", "google_ads"]]);
    expect(hold).not.toHaveBeenCalled();
    expect(gads).not.toHaveBeenCalled();
  });

  it("an unreadable stop refuses too", async () => {
    stop.value = null;
    const r = await HANDLERS["google_ads.update_campaign_budget"]({ ...row });
    expect(r).toMatchObject({ ok: false, code: "founder_stopped" });
    expect(gads).not.toHaveBeenCalled();
  });

  it("must-not-touch: a channel that is not stopped goes on to the next checks", async () => {
    const r = await HANDLERS["google_ads.update_campaign_budget"]({ ...row });
    expect(r).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it("must-not-touch: a test stop's own pause skips the stop read", async () => {
    stop.value = true;
    await HANDLERS["google_ads.update_campaign_budget"]({ ...row, test_stop_pause: true } as typeof row).catch(() => undefined);
    expect(stop.calls).toEqual([]);
  });
});
