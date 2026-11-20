
import { describe, it, expect } from "vitest";
import { channelPendingCounts } from "@/routes/approvals/list";

const runs: Record<string, string> = {
  "run-meta": "meta_ads",
  "run-seo": "seo",
  "run-x": "x_organic",
};
const channelOf = (id: string) => runs[id] ?? null;

describe("channelPendingCounts", () => {
  it("counts every pending row, not just the ones a capped page carried", () => {
    const all = [
      ...Array.from({ length: 21 }, () => ({ agent_run_id: "run-meta" })),
      ...Array.from({ length: 3 }, () => ({ agent_run_id: "run-seo" })),
    ];
    expect(channelPendingCounts(all, channelOf)).toEqual({
      meta_ads: 21,
      seo: 3,
    });
  });

  it("is what stops a starved channel reading as Done", () => {
    const page = [{ agent_run_id: "run-x" }];
    const everything = [
      { agent_run_id: "run-x" },
      ...Array.from({ length: 21 }, () => ({ agent_run_id: "run-meta" })),
    ];
    expect(channelPendingCounts(page, channelOf).meta_ads).toBeUndefined();
    expect(channelPendingCounts(everything, channelOf).meta_ads).toBe(21);
  });

  it("omits a channel with nothing pending rather than writing a zero", () => {
    const counts = channelPendingCounts([{ agent_run_id: "run-seo" }], channelOf);
    expect("meta_ads" in counts).toBe(false);
    expect(counts.seo).toBe(1);
  });

  it("skips a decision whose run carries no channel — that is not channel work", () => {
    expect(
      channelPendingCounts([{ agent_run_id: "run-unstamped" }], channelOf),
    ).toEqual({});
  });

  it("skips a run-less decision that is not a human review card", () => {
    expect(
      channelPendingCounts(
        [{ agent_run_id: null, decision_class: "pm.needs_action" }],
        channelOf,
      ),
    ).toEqual({});
  });

  it("counts a run-less social post under the channel its body.channel maps to", () => {
    expect(
      channelPendingCounts(
        [{ agent_run_id: null, decision_class: "social.publish.v2", social_channel: "tiktok_video" }],
        channelOf,
      ),
    ).toEqual({ tiktok_organic: 1 });
  });

  it("counts a social post from an UNSTAMPED run (growth-lead post-run) by body.channel", () => {
    expect(
      channelPendingCounts(
        [{ agent_run_id: "run-unstamped", decision_class: "social.publish.v2", social_channel: "linkedin_image" }],
        channelOf,
      ),
    ).toEqual({ linkedin_organic: 1 });
  });

  it("lets a stamped run's channel win over body.channel", () => {
    expect(
      channelPendingCounts(
        [{ agent_run_id: "run-x", decision_class: "social.publish.v2", social_channel: "tiktok_video" }],
        channelOf,
      ),
    ).toEqual({ x_organic: 1 });
  });

  it("skips a social post with an unknown action key", () => {
    expect(
      channelPendingCounts(
        [{ agent_run_id: null, decision_class: "social.publish.v2", social_channel: "myspace" }],
        channelOf,
      ),
    ).toEqual({});
  });

  it("counts nothing for an empty pending set", () => {
    expect(channelPendingCounts([], channelOf)).toEqual({});
  });
});
