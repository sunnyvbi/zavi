
import { describe, expect, it, vi } from "vitest";

const runGeneric = vi.hoisted(() => vi.fn());
vi.mock("@/services/agents/generic-dispatcher", () => ({ runGeneric, writesSuppressed: () => false }));
const switched = vi.hoisted(() => vi.fn(async () => "meta_ads"));
vi.mock("@/services/channels/channel-actions", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/channel-actions")>()),
  switchedChannelForRun: switched,
  recordChannelRunActions: vi.fn(),
}));

import { TOP_ACTIONS, TOP_ACTION_FINAL_REPLY } from "@/services/channels/top-actions";
import { channelRecipeStepEnvelopeSchema } from "@/agents/lib/channel-recipe-step";
import { tryParseEnvelopePayload } from "@/services/agents/envelope-json";
import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { recordChannelRunActions } from "@/services/channels/channel-actions";

const inputs = { about: "Halloween deal", link: "https://upcar.ai/h", goal: "visit", placement: "both", daily_budget: 20 };
const payload = { channel_slug: "meta_ads", top_action: { key: "create_new_ad", inputs, instruction: "x", by: "u1" } };

describe("top-action final reply", () => {
  it("the instruction asks for the digest envelope with empty steps", () => {
    expect(TOP_ACTIONS.meta_ads.create_new_ad.instruction(inputs)).toContain(TOP_ACTION_FINAL_REPLY);
  });

  it("the reply it asks for parses as a valid channel envelope with no steps", () => {
    const reply = '<digest>{"rendered_markdown": "Filed one new campaign at 20 a day for approval.", "steps": []}</digest>';
    const inner = reply.match(/<digest>([\s\S]*?)<\/digest>/)![1];
    const r = tryParseEnvelopePayload(inner, { envelope_name: "digest" });
    expect(r.kind).toBe("strict");
    const z = channelRecipeStepEnvelopeSchema.safeParse(r.kind === "failed" ? null : r.value);
    expect(z.success).toBe(true);
    if (z.success) expect(z.data.steps).toEqual([]);
  });

  it("a parsed top-action run stays parse_ok and records no recipe-step cards", async () => {
    const parsed = { rendered_markdown: "Filed one new campaign.", steps: [] };
    runGeneric.mockResolvedValue({ parse_ok: true, parsed, raw_text: "", side_effect: null });
    const dispatch = createSideEffectDispatcher({ slug: "meta_ads", decisionClass: "channel.recipe_step", schema: channelRecipeStepEnvelopeSchema });
    const r = await dispatch({ tenant_id: "t", runId: "r", agent: { slug: "meta_ads" } } as never, payload);
    expect(r.parse_ok).toBe(true);
    expect(recordChannelRunActions).not.toHaveBeenCalled();
  });
});
