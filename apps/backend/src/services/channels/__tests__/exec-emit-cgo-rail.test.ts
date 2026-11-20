import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ anchorRuns: [] as string[] }));
vi.mock("@/services/growth/cgo-ad-orders", () => ({
  ensureCgoOrderRun: async (_t: string, channel: string) => {
    s.anchorRuns.push(channel);
    return `anchor-${channel}`;
  },
}));

import { cgoChannelRailEmit, readsAsCgoRun } from "../exec-emit";
import { cgoLinkedInLaunchEmit } from "@/services/tools/linkedin-ads/_exec-action";
import type { EmitDecisionFn, ExecEmitCtx } from "../exec-emit";

const legacy: EmitDecisionFn = async () => "decision-1";
const ctx = (over: Partial<ExecEmitCtx> = {}): ExecEmitCtx => ({ tenant_id: "T", run_id: "run-cgo", emit_decision: legacy, ...over });
const isCgo = (yes: boolean) => async () => yes;
const filed: Array<{ run_id: string | undefined; cls: string }> = [];
const channelWriter = async (c: ExecEmitCtx): Promise<EmitDecisionFn | undefined> => async (cls) => {
  filed.push({ run_id: c.run_id, cls });
  return "action-1";
};

beforeEach(() => {
  s.anchorRuns = [];
  filed.length = 0;
});

describe("TikTok and Reddit on a cgo run: the channel's Actions tab, through the cgo stand-in run", () => {
  it("MUST CATCH (run fd629982): a cgo chat run's TikTok launch is filed on the tiktok_ads stand-in run, not refused", async () => {
    const emit = await cgoChannelRailEmit(ctx(), "tiktok_ads", channelWriter, isCgo(true));
    expect(emit).toBeTypeOf("function");
    expect(await emit!("tiktok_ads.create_launch", {})).toBe("action-1");
    expect(s.anchorRuns).toEqual(["tiktok_ads"]);
    expect(filed).toEqual([{ run_id: "anchor-tiktok_ads", cls: "tiktok_ads.create_launch" }]);
  });

  it("Reddit the same way, on its own stand-in run", async () => {
    const emit = await cgoChannelRailEmit(ctx(), "reddit_ads", channelWriter, isCgo(true));
    await emit!("reddit_ads.launch_campaign", {});
    expect(filed).toEqual([{ run_id: "anchor-reddit_ads", cls: "reddit_ads.launch_campaign" }]);
  });

  it("any other run (operator chat) gets no writer, so the launch is still refused", async () => {
    expect(await cgoChannelRailEmit(ctx(), "tiktok_ads", channelWriter, isCgo(false))).toBeUndefined();
    expect(s.anchorRuns).toEqual([]);
  });

  it("no run id or no legacy emit: no writer", async () => {
    expect(await cgoChannelRailEmit(ctx({ run_id: undefined }), "tiktok_ads", channelWriter, isCgo(true))).toBeUndefined();
    expect(await cgoChannelRailEmit(ctx({ emit_decision: undefined }), "tiktok_ads", channelWriter, isCgo(true))).toBeUndefined();
  });

  it("a run that writes nothing files nothing; a redo refuses at the emit", async () => {
    const quiet = await cgoChannelRailEmit(ctx({ writes_suppressed: true }), "tiktok_ads", channelWriter, isCgo(true));
    expect(await quiet!("tiktok_ads.create_launch", {})).toBe("channel_action_suppressed");
    const redo = await cgoChannelRailEmit(ctx({ redo: true }), "tiktok_ads", channelWriter, isCgo(true));
    await expect(redo!("tiktok_ads.create_launch", {})).rejects.toMatchObject({ code: "redo_scope" });
    expect(filed).toEqual([]);
    expect(s.anchorRuns).toEqual([]);
  });

  it("the stand-in run is made only when a card is filed", async () => {
    await cgoChannelRailEmit(ctx(), "tiktok_ads", channelWriter, isCgo(true));
    expect(s.anchorRuns).toEqual([]);
  });

  it("an unreadable run row counts as not a cgo run: no writer, nothing filed", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    expect(await readsAsCgoRun("T", "r", boom)).toBe(false);
    expect(await cgoChannelRailEmit(ctx(), "tiktok_ads", channelWriter, boom)).toBeUndefined();
  });
});

describe("LinkedIn on a cgo run: the Meta/Google decisions rail, launch only", () => {
  it("a cgo run's LinkedIn launch goes to the run's own emit_decision", async () => {
    const emit = await cgoLinkedInLaunchEmit(ctx(), isCgo(true));
    expect(await emit!("linkedin_ads.launch_campaign", {})).toBe("decision-1");
  });

  it("any other LinkedIn change from cgo is refused; any other run gets no writer", async () => {
    const emit = await cgoLinkedInLaunchEmit(ctx(), isCgo(true));
    await expect(emit!("linkedin_ads.set_status", {})).rejects.toMatchObject({ code: "linkedin_ads_propose_not_channel_run" });
    expect(await cgoLinkedInLaunchEmit(ctx(), isCgo(false))).toBeUndefined();
  });
});
