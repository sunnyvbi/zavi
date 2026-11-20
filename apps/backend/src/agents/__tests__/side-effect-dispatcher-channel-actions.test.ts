import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runGeneric = vi.fn();
vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => runGeneric(...args),
  writesSuppressed: (ctx: { shadow_mode?: boolean; draft_mode?: boolean }) =>
    ctx.shadow_mode === true || ctx.draft_mode === true,
}));
const switchedChannelForRun = vi.fn();
const recordChannelRunActions = vi.fn();
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: (...a: unknown[]) => switchedChannelForRun(...a),
  recordChannelRunActions: (...a: unknown[]) => recordChannelRunActions(...a),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached");
  },
}));
vi.mock("@/services/decisions/dispatch-interactive", () => ({
  dispatchInteractiveDecision: vi.fn(async () => undefined),
}));

const settleLaunchCards = vi.fn();
vi.mock("@/services/growth/linkedin-run-verdict", () => ({
  settleLinkedinRunLaunchCards: (...a: unknown[]) => settleLaunchCards(...a),
}));

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";

const STEP = {
  title: "Enable the booking conversion action",
  body: "b",
  blocking: true,
  effort: "minutes",
  evidence: ["e"],
};
const LEGACY_ENVELOPE = { rendered_markdown: "x", steps: [STEP, { ...STEP, title: "Second", blocking: false }] };
const NEW_ENVELOPE = {
  rendered_markdown: "x",
  steps: [
    { ...STEP, action_type: "fix", impact: { value: 4, reason: "moves signups" }, repeat_of: "11111111-2222-3333-4444-555555555555" },
    { ...STEP, title: "Second", blocking: false, action_type: "check" },
  ],
  metrics: [{ key: "spend_7d", value: 1410, source: "t" }],
  stale: [{ action_id: "11111111-2222-3333-4444-555555555555", evidence: "done" }],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeCtx = (over: Record<string, unknown> = {}): any => ({
  tenant_id: "t-1",
  runId: "run-1",
  agent: { slug: "google_ads" },
  emitDecision: vi.fn().mockResolvedValue("dec-1"),
  ...over,
});

const dispatch = createSideEffectDispatcher({
  slug: "google_ads",
  decisionClass: "channel.recipe_step",
  fanOut: stepDecisionBodies,
});

beforeEach(() => {
  vi.clearAllMocks();
  runGeneric.mockImplementation(async (_ctx: unknown, payload: unknown) => ({
    parse_ok: true,
    parsed: payload,
    tool_calls: [],
  }));
  recordChannelRunActions.mockResolvedValue({ ids: [{ position: 1, id: "a1" }] });
});

describe("switched channel", () => {
  beforeEach(() => switchedChannelForRun.mockResolvedValue("google_ads"));

  it("writes ONE record call and never emits a decision", async () => {
    const ctx = makeCtx();
    const res = await dispatch(ctx, NEW_ENVELOPE);
    expect(ctx.emitDecision).not.toHaveBeenCalled();
    expect(recordChannelRunActions).toHaveBeenCalledTimes(1);
    const arg = recordChannelRunActions.mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: "t-1", runId: "run-1", channelSlug: "google_ads", redo: null });
    expect(arg.bodies).toHaveLength(2);
    expect(arg.bodies[0].step.action_type).toBe("fix");
    expect(res.side_effect).toEqual({ kind: "shipped", detail: "a1" });
  });

  it("a chat turn passes the card ids its successful tool calls returned; other runs pass none", async () => {
    const calls = [
      { name: "meta_ads__propose_status_change", status: "ok", returned_ids: ["c-1"] },
      { name: "meta_ads__propose_budget_change", status: "tool_error", returned_ids: ["c-2"] },
      { name: "meta_ads__list_campaigns", status: "ok" },
    ];
    runGeneric.mockImplementation(async (_ctx: unknown, payload: unknown) => ({ parse_ok: true, parsed: payload, tool_calls: calls }));
    await dispatch(makeCtx({ trigger: "chat" }), NEW_ENVELOPE);
    expect(recordChannelRunActions.mock.calls[0][0].chat).toEqual({ toolCardIds: ["c-1"] });
    await dispatch(makeCtx({ trigger: "channel_recipe" }), NEW_ENVELOPE);
    expect(recordChannelRunActions.mock.calls[1][0].chat).toBeUndefined();
  });

  it.each([["shadow_mode"], ["draft_mode"]])("a %s run writes nothing at all", async (flag) => {
    const ctx = makeCtx({ [flag]: true });
    await dispatch(ctx, NEW_ENVELOPE);
    expect(recordChannelRunActions).not.toHaveBeenCalled();
    expect(ctx.emitDecision).not.toHaveBeenCalled();
  });

  it("a redo run carries its channel_actions target to the writer", async () => {
    const ctx = makeCtx();
    await dispatch(ctx, {
      ...NEW_ENVELOPE,
      redo: { redo_of_action_id: "old-1", origin_position: 2, origin_of: 5, note: "sharper" },
    });
    expect(recordChannelRunActions.mock.calls[0][0].redo).toEqual({
      redo_of_action_id: "old-1",
      origin_position: 2,
      origin_of: 5,
      note: "sharper",
    });
  });

  it.each([
    ["instagram_organic", "channel_recipe", "rewrite_bio", true],
    ["instagram_organic", "scheduled", "rewrite_bio", false],
    ["instagram_organic", "channel_recipe", "draft_reel", false],
    ["linkedin_organic", "channel_recipe", "rewrite_bio", false],
  ])("passes the requested-bio identity only for its validated channel action (%s/%s/%s)", async (switched, trigger, key, expected) => {
    switchedChannelForRun.mockResolvedValue(switched);
    await dispatch(makeCtx({ trigger }), {
      ...NEW_ENVELOPE, channel_slug: "instagram_organic",
      top_action: { key, inputs: {}, by: "founder" },
    });
    expect(recordChannelRunActions.mock.calls[0][0].topAction).toBe(expected ? "rewrite_bio" : undefined);
  });

  it("a writer failure fails loudly", async () => {
    recordChannelRunActions.mockRejectedValueOnce(new Error("record_channel_run_actions failed: boom"));
    await expect(dispatch(makeCtx(), NEW_ENVELOPE)).rejects.toThrow(/boom/);
  });
});

describe("unswitched channel (every channel in PR 1)", () => {
  beforeEach(() => switchedChannelForRun.mockResolvedValue(null));

  it("emits exactly today's bodies: the new step fields are stripped", async () => {
    const legacyCtx = makeCtx();
    await dispatch(legacyCtx, LEGACY_ENVELOPE);
    const newCtx = makeCtx();
    await dispatch(newCtx, NEW_ENVELOPE);
    expect(recordChannelRunActions).not.toHaveBeenCalled();
    const legacy = legacyCtx.emitDecision.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    const now = newCtx.emitDecision.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    expect(now).toEqual(legacy);
    expect(newCtx.emitDecision).toHaveBeenCalledTimes(2);
  });

  it("a body without the new fields is passed through as the same object shape", async () => {
    const ctx = makeCtx();
    await dispatch(ctx, LEGACY_ENVELOPE);
    expect(ctx.emitDecision.mock.calls[0][1]).toEqual(stepDecisionBodies(LEGACY_ENVELOPE)[0]);
  });
});

describe("other decision classes", () => {
  it("never consult the channel switch", async () => {
    const other = createSideEffectDispatcher({ slug: "engineer", decisionClass: "engineer.ship_pr" });
    const ctx = makeCtx();
    await other(ctx, { rendered_markdown: "x" });
    expect(switchedChannelForRun).not.toHaveBeenCalled();
    expect(ctx.emitDecision).toHaveBeenCalledTimes(1);
  });
});

describe("source guard", () => {
  it("checks writesSuppressed(ctx) before the direct record call", () => {
    const src = readFileSync(join(__dirname, "../lib/side-effect-dispatcher.ts"), "utf8");
    const gate = src.indexOf("if (writesSuppressed(ctx)) return result;");
    const write = src.indexOf("await recordChannelRunActions(");
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
  });
});

describe("LinkedIn launch cards at the end of a run", () => {
  const linkedin = createSideEffectDispatcher({
    slug: "linkedin_ads",
    decisionClass: "channel.recipe_step",
    fanOut: stepDecisionBodies,
    shouldEmit: () => false,
  });
  const verdict = { verdict: "not_here", reason: "Not here." };

  beforeEach(() => {
    settleLaunchCards.mockReset();
  });

  it("hands the run's own verdict to the settle step, even when the run emits no steps", async () => {
    await linkedin(makeCtx({ agent: { slug: "linkedin_ads" } }), { rendered_markdown: "x", steps: [], fit: verdict });
    expect(settleLaunchCards).toHaveBeenCalledWith("t-1", "run-1", verdict);
  });

  it("a failed settle does not fail the run", async () => {
    settleLaunchCards.mockRejectedValue(new Error("down"));
    await expect(linkedin(makeCtx({ agent: { slug: "linkedin_ads" } }), { rendered_markdown: "x", steps: [], fit: verdict })).resolves.toBeTruthy();
  });

  it.each([
    ["another channel", { agent: { slug: "google_ads" } }, {}],
    ["a shadow run", { agent: { slug: "linkedin_ads" }, shadow_mode: true }, {}],
    ["a dry preview", { agent: { slug: "linkedin_ads" }, preview_dry: true }, {}],
    ["a redo", { agent: { slug: "linkedin_ads" } }, { redo: { action_id: "11111111-2222-3333-4444-555555555555" } }],
  ])("%s does not settle", async (_name, ctxOver, extra) => {
    runGeneric.mockImplementation(async () => ({ parse_ok: true, parsed: { rendered_markdown: "x", steps: [], fit: verdict }, tool_calls: [] }));
    await linkedin(makeCtx(ctxOver), { rendered_markdown: "x", steps: [], fit: verdict, ...extra });
    expect(settleLaunchCards).not.toHaveBeenCalled();
  });
});

describe("a LinkedIn Ads not-yet run files the cards artifact.md asks for", () => {
  const linkedinCards = createSideEffectDispatcher({ slug: "linkedin_ads", decisionClass: "channel.recipe_step", fanOut: stepDecisionBodies });
  beforeEach(() => switchedChannelForRun.mockResolvedValue("linkedin_ads"));

  it("must-catch: the verdict step and the audiences for review are filed, the copy sheet is not", async () => {
    await linkedinCards(makeCtx({ agent: { slug: "linkedin_ads" } }), {
      rendered_markdown: "Not yet.",
      fit: { verdict: "not_here", reason: "One customer is worth less than the test." },
      steps: [
        { ...STEP, title: "Put the buyer's role on the homepage", body: "Not yet: one customer is worth $200 and a readable test is $350." },
        { ...STEP, title: "Review two audiences for when it flips", deliverable: { kind: "list", label: "Two audiences", content: "AUDIENCE 1" } },
        { ...STEP, title: "Paste the copy sheet", deliverable: { kind: "ad", label: "Copy sheet", content: "VARIANT A" } },
      ],
    });
    expect(recordChannelRunActions).toHaveBeenCalledTimes(1);
    const titles = recordChannelRunActions.mock.calls[0][0].bodies.map((b: { step: { title: string } }) => b.step.title);
    expect(titles).toEqual(["Put the buyer's role on the homepage", "Review two audiences for when it flips"]);
  });
});
