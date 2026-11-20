
import { describe, expect, it } from "vitest";
import { channelIsSwitched, readSwitchedChannelRows, toStepRow } from "../_channel-action-rows";
import type { ChannelActionView } from "@/services/channels/channel-actions";

const view = (over: Partial<ChannelActionView>): ChannelActionView => ({
  id: "a1",
  channel_slug: "google_ads",
  run_id: "r1",
  position: 1,
  run_of: 3,
  blocking: false,
  action_type: "fix",
  title: "Do the thing",
  body: { step: { title: "Do the thing" } },
  status: "pending",
  note: null,
  snoozed_until: null,
  impact: null,
  impact_reason: null,
  score: 50,
  score_inputs: {},
  proposed_at: "2026-09-19T10:00:00Z",
  repeat_of: null,
  redo_of: null,
  executable: false,
  exec_status: null,
  edited_body: null,
  source: "channel_action",
  card_kind: null,
  primary_label: null,
  done_label: null,
  how_to: [],
  steps_done: [],
  plan_day: null,
  plan_day_source: null,
  series: null,
  ...over,
});

describe("channelIsSwitched", () => {
  it("answers for a switched channel and for a non-channel", () => {
    expect(channelIsSwitched("google_ads")).toBe(true);
    expect(channelIsSwitched("youtube_ads")).toBe(true);
    expect(channelIsSwitched("not_a_channel")).toBe(false);
  });
});

describe("toStepRow", () => {
  it("gives the panels the shape they already parse", () => {
    expect(toStepRow(view({}))).toEqual({
      id: "a1",
      decision_class: "channel.recipe_step",
      body: { step: { title: "Do the thing" } },
      emitted_at: "2026-09-19T10:00:00Z",
      agent_run_id: "r1",
      executable: false,
      exec_status: null,
      exec_in_flight: false,
    });
  });

  it("carries the executable flags an ad card branches on", () => {
    expect(toStepRow(view({ executable: true, exec_status: "queued" }))).toMatchObject({
      executable: true,
      exec_status: "queued",
      exec_in_flight: true,
    });
    expect(toStepRow(view({ executable: true, exec_status: "dispatching" })).exec_in_flight).toBe(true);
    expect(toStepRow(view({ executable: true, exec_status: "failed" })).exec_in_flight).toBe(false);
    expect(toStepRow(view({ executable: true, exec_status: "executed" })).exec_in_flight).toBe(false);
  });

  it("a missing body is null, never an invented object", () => {
    expect(toStepRow(view({ body: null })).body).toBeNull();
  });
});

describe("readSwitchedChannelRows", () => {
  it("does no read at all for an unswitched channel", async () => {
    await expect(readSwitchedChannelRows("t-1", "reddit_organic")).resolves.toEqual([]);
  });
});
