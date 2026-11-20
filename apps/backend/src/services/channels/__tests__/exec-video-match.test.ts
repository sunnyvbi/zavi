import { describe, it, expect, vi } from "vitest";
import { matchExecCard, type ExecActionInput } from "../exec-actions";
import { execCardTarget, targetKeyOf } from "../exec-card-identity";
import { targetFromKey, type PoolCard } from "../card-matcher";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CLASS = "generated_video.render.v1";

const SCRIPTS = {
  explainer: "Here's a finished cake, message on top. Order a day ahead, then collect it or have it delivered.",
  hook: "Still buying a cake out of a glass case? Ours is baked the day you collect it.",
  behind_the_scenes: "Five a.m., the ovens are on. This is how your cake gets made, start to finish.",
  offer: "Order by Thursday and the message on top is free. That's the whole deal.",
  product_demo: "Pick the size, the flavor, the filling and the message. Three taps and it's ordered.",
};

function input(format: keyof typeof SCRIPTS, script = SCRIPTS[format]): ExecActionInput {
  return {
    tenantId: TENANT,
    runId: "run-batch",
    channelSlug: "generated_video",
    execClass: CLASS,
    execPayload: { intake: { intent: "talking_head", aspect_ratio: "9:16", script }, format },
    actionType: "video_post" as ExecActionInput["actionType"],
    title: `${format}: a cake video`,
    body: { step: { body: "Approve to make this as a 20-second vertical video about the cake shop." } },
  };
}

function poolCard(id: string, format: keyof typeof SCRIPTS, status: PoolCard["status"] = "open"): PoolCard {
  const key = targetKeyOf(execCardTarget(CLASS, input(format).execPayload));
  return { id, channel: "generated_video", status, title: `${format}: a cake video`, summary: "a cake video", action_type: "video_post", target: targetFromKey(key) };
}

describe("five AI UGC scripts in one run all become cards", () => {
  it("never asks the judge to compare two different scripts, so none is dropped or replaced", async () => {
    const match = vi.fn();
    const pool = [poolCard("made-video", "explainer"), poolCard("p2", "hook"), poolCard("p3", "behind_the_scenes"), poolCard("p4", "offer")];
    const m = await matchExecCard(input("product_demo"), "generated_video", targetKeyOf(execCardTarget(CLASS, input("product_demo").execPayload)), {
      enabled: () => true,
      loadPool: vi.fn(async () => pool) as never,
      match,
    });
    expect(match).not.toHaveBeenCalled();
    expect(m.repeatOf).toBeNull();
    expect(m.drop).toBeNull();
  });

  it("a word-for-word repeat of an open script is still a candidate for the judge", async () => {
    const match = vi.fn(async () => ({ verdicts: [{ ref: "n0", decision: "new" as const, match_id: null }], input_tokens: 1, output_tokens: 1 }));
    const pool = [poolCard("same", "hook")];
    await matchExecCard(input("hook"), "generated_video", targetKeyOf(execCardTarget(CLASS, input("hook").execPayload)), {
      enabled: () => true,
      loadPool: vi.fn(async () => pool) as never,
      match: match as never,
    });
    expect(match).toHaveBeenCalledTimes(1);
  });
});
