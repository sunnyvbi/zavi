import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { chatAskFromToolCalls, chatAskNotQueuedLine, isChatAskQueuedTrace, queueChatAskReview, type QueueChatAskDeps } from "../chat-ask";
import { fillTraceFromToolResult, previewJson, OUTPUT_PREVIEW_BYTES, type ToolCallTrace } from "@/services/tools/types";
import { removeUnbackedActionClaims, verifyActionAndLiveReadClaims } from "@/services/agents/claim-grounding-verifier";
import { queueChatAskFromTurn } from "@/agents/cgo/post-run";

const T = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const request = { ask: "Rerun channel content for the new product", channels: ["instagram", "reddit"] };

type Mocked = { [K in keyof QueueChatAskDeps]: Mock<any[], any> };
let deps: Mocked;
beforeEach(() => {
  deps = {
    words: vi.fn<any[], any>(async () => "Reset everything and rerun it for the new product"),
    pending: vi.fn<any[], any>(async () => null),
    own: vi.fn<any[], any>(async () => null),
    enqueue: vi.fn<any[], any>(async () => ({ enqueued: true as const, run_id: "rev-1" })),
  };
});
const queue = () => queueChatAskReview({ tenant_id: T, run_id: RUN, user_id: USER, request }, deps as unknown as QueueChatAskDeps);

describe("queueChatAskReview", () => {
  it("queues the founder_reply review: founder's words as text, cgo's reading apart, Autopilot required, keyed by the chat run", async () => {
    expect(await queue()).toEqual({ queued: true, review_run_id: "rev-1" });
    expect(deps.enqueue).toHaveBeenCalledWith({
      tenant_id: T,
      reason: "founder_reply",
      require_autopilot: true,
      founder_reply: {
        via: "chat",
        text: "Reset everything and rerun it for the new product",
        reply_run_id: `chat:${RUN}`,
        cgo_reading: "Rerun channel content for the new product Channels named: instagram, reddit.",
      },
    });
  });

  it("a retry of the same turn finds its own review (any status) and reports it queued", async () => {
    deps.own.mockResolvedValue("rev-0");
    expect(await queue()).toEqual({ queued: true, review_run_id: "rev-0" });
    expect(deps.own).toHaveBeenCalledWith(T, `chat:${RUN}`);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("a duplicate slot is this turn's review only when its own key is there; otherwise another review took it", async () => {
    deps.enqueue.mockResolvedValue({ enqueued: false, skipped: "duplicate" });
    expect(await queue()).toEqual({ queued: false, why: "busy" });
    deps.own.mockResolvedValueOnce(null).mockResolvedValueOnce("rev-race");
    expect(await queue()).toEqual({ queued: true, review_run_id: "rev-race" });
  });

  it("does not stack on another chat ask still in flight", async () => {
    deps.pending.mockResolvedValue({ id: "rev-0", key: "chat:another-run" });
    expect(await queue()).toEqual({ queued: false, why: "already_queued" });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("queues nothing on the model's summary alone", async () => {
    deps.words.mockResolvedValue(null);
    expect(await queue()).toEqual({ queued: false, why: "words_unreadable" });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it.each(["daily_cap", "autopilot_off", "no_active_goals"] as const)("passes %s through", async (skipped) => {
    deps.enqueue.mockResolvedValue({ enqueued: false, skipped });
    expect(await queue()).toEqual({ queued: false, why: skipped });
  });

  it("an unknown skip is a failure, never 'already queued'", async () => {
    deps.enqueue.mockResolvedValue({ enqueued: false, skipped: "recent_review" });
    expect(await queue()).toEqual({ queued: false, why: "failed" });
  });

  it("never throws: no credits and read failures are outcomes", async () => {
    const e = new Error("insufficient credits");
    e.name = "InsufficientCreditsError";
    deps.enqueue.mockRejectedValue(e);
    expect(await queue()).toEqual({ queued: false, why: "no_credits" });
    deps.words.mockRejectedValue(new Error("db down"));
    expect(await queue()).toEqual({ queued: false, why: "failed" });
  });
});

describe("reading the tool's answer from real traces", () => {
  const answer = { status: "will_queue", say: "x", request };
  const sdkTrace = (): ToolCallTrace => {
    const t: ToolCallTrace = { name: "mcp__growth__growth__start_channel_work", input_preview: "{}", output_preview: "", ms: 1, status: "ok" };
    fillTraceFromToolResult(t, { content: [{ type: "text", text: JSON.stringify(answer) }] });
    return t;
  };
  const legacyTrace = (): ToolCallTrace => ({
    name: "growth__start_channel_work", input_preview: "{}", ms: 1, status: "ok",
    output_preview: previewJson(JSON.stringify(answer), OUTPUT_PREVIEW_BYTES),
  });

  it("decodes both the SDK block shape and the legacy string shape", () => {
    expect(chatAskFromToolCalls([sdkTrace()])).toEqual(request);
    expect(chatAskFromToolCalls([legacyTrace()])).toEqual(request);
    expect(isChatAskQueuedTrace(sdkTrace())).toBe(true);
  });

  it("the will_queue answer is the receipt for the promised review in the reply guard", () => {
    const text = "I'm queuing a goal review with your ask now.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [sdkTrace()] })).toEqual({ text, removed: 0 });
    expect(removeUnbackedActionClaims({ text, toolCalls: [] }).removed).toBeGreaterThan(0);
    const mixed = "I'm queuing a goal review with your ask now. I'm posting the new campaign on Instagram.";
    const out = removeUnbackedActionClaims({ text: mixed, toolCalls: [sdkTrace()] });
    expect(out.removed).toBe(1);
    expect(out.text).toContain("queuing a goal review");
    expect(out.text).not.toContain("posting the new campaign");
    expect(verifyActionAndLiveReadClaims({ reply: text, toolCalls: [sdkTrace()] }).flagged).toBe(false);
    expect(verifyActionAndLiveReadClaims({ reply: mixed, toolCalls: [sdkTrace()] }).flagged).toBe(true);
    expect(verifyActionAndLiveReadClaims({ reply: "I'm queuing a goal review\nI'm posting the campaign", toolCalls: [sdkTrace()] }).flagged).toBe(true);
  });
});

describe("chatAskFromToolCalls", () => {
  const call = (out: unknown, over: Record<string, unknown> = {}) => ({ name: "mcp__growth__growth__start_channel_work", status: "ok", output_preview: JSON.stringify(out), ...over });
  it("takes the last will_queue answer and ignores errors, other tools, other statuses and unparsable previews", () => {
    expect(chatAskFromToolCalls(undefined)).toBeNull();
    expect(
      chatAskFromToolCalls([
        call({ status: "will_queue", request: { ask: "first", channels: [] } }),
        call({ status: "will_queue", request: { ask: "second", channels: ["x", "Bad Slug"] } }),
        call({ status: "daily_cap" }),
        call({ status: "will_queue", request: { ask: "errored" } }, { status: "tool_error" }),
        call({ status: "will_queue", request: { ask: "other tool" } }, { name: "growth__read_ads_perf" }),
        { name: "growth__start_channel_work", status: "ok", output_preview: "{not json" },
      ]),
    ).toEqual({ ask: "second", channels: ["x"] });
  });
});

describe("queueChatAskFromTurn (cgo post-run)", () => {
  const ctx = (over: Record<string, unknown> = {}) => ({ tenant_id: T, runId: RUN, trigger: "chat", actor: { actor_user_id: USER }, ...over }) as never;
  const result = (out: unknown) =>
    ({
      output_text: "On it.",
      parsed: { rendered_markdown: "On it." },
      parse_ok: true,
      tool_calls: [{ name: "growth__start_channel_work", status: "ok", output_preview: JSON.stringify(out) }],
    }) as never as { output_text: string; parsed: { rendered_markdown: string } };

  it("queues the review after the turn and leaves the reply alone when it starts", async () => {
    const q = vi.fn(async () => ({ queued: true as const, review_run_id: "rev-1" }));
    const r = result({ status: "will_queue", request });
    await queueChatAskFromTurn(ctx(), r as never, { queue: q });
    expect(q).toHaveBeenCalledWith({ tenant_id: T, run_id: RUN, user_id: USER, request });
    expect(r.output_text).toBe("On it.");
  });

  it("adds one correction line to every rendered text when the review did not start", async () => {
    const q = vi.fn(async () => ({ queued: false as const, why: "daily_cap" as const }));
    const r = result({ status: "will_queue", request });
    await queueChatAskFromTurn(ctx(), r as never, { queue: q });
    expect(r.output_text).toBe(`On it.\n\n${chatAskNotQueuedLine("daily_cap")}`);
    expect(r.parsed.rendered_markdown).toBe(r.output_text);
  });

  it("an ok answer that cannot be read back gets the correction line, not silence", async () => {
    const q = vi.fn();
    const r = { output_text: "On it.", parsed: null, parse_ok: true, tool_calls: [{ name: "growth__start_channel_work", status: "ok", output_preview: "{trunc" }] };
    await queueChatAskFromTurn(ctx(), r as never, { queue: q as never });
    expect(q).not.toHaveBeenCalled();
    expect(r.output_text).toBe(`On it.\n\n${chatAskNotQueuedLine("failed")}`);
  });

  it("does nothing outside a chat turn, or when the tool did not answer will_queue", async () => {
    const q = vi.fn();
    await queueChatAskFromTurn(ctx({ trigger: "a2a" }), result({ status: "will_queue", request }) as never, { queue: q as never });
    await queueChatAskFromTurn(ctx(), result({ status: "autopilot_off" }) as never, { queue: q as never });
    expect(q).not.toHaveBeenCalled();
  });
});
