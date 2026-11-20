import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { runStartChannelWork, type StartChannelWorkDeps } from "../start_channel_work";
import { chatAskFromToolCalls } from "@/services/growth/chat-ask";
import type { ToolContext } from "@/services/tools/types";

const T = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  tenant_id: T,
  run_id: RUN,
  agent_slug: "cgo",
  run_trigger: "chat",
  founder_chat_order: true,
  actor: { actor_user_id: USER, actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" },
  log: () => {},
  ...over,
});

type Mocked = { [K in keyof StartChannelWorkDeps]: Mock<any[], any> };
let deps: Mocked;
beforeEach(() => {
  deps = {
    founderWords: vi.fn<any[], any>(async () => "Reset the content and rerun it for our new product"),
    admission: vi.fn<any[], any>(async () => null),
    pending: vi.fn<any[], any>(async () => null),
  };
});
const run = (c: ToolContext, raw: unknown = ask) => runStartChannelWork(c, raw, deps as unknown as StartChannelWorkDeps);

const ask = { ask: "Rerun channel content for the new product focus", channels: ["instagram", "instagram", "reddit"] };

describe("growth__start_channel_work", () => {
  it("a LinkedIn money order is not turned into a goal review that loses the founder's order", async () => {
    deps.founderWords.mockResolvedValue("spend $200 on LinkedIn for 14 days");
    const r = await run(ctx(), { ask: "Spend on LinkedIn", channels: ["linkedin_ads"] });
    expect(r.status).toBe("linkedin_order_elsewhere");
    expect(r.request).toBeUndefined();
    expect(r.say).toMatch(/nothing was started/);
    expect(deps.admission).not.toHaveBeenCalled();
  });

  it("answers will_queue with the request post-run needs, and queues nothing itself", async () => {
    const r = await run(ctx());
    expect(r).toEqual({
      status: "will_queue",
      say: expect.stringMatching(/I'll queue a goal review/),
      request: { ask: ask.ask, channels: ["instagram", "reddit"] },
    });
    expect(r.say).toMatch(/may hand out none/);
    expect(deps.founderWords).toHaveBeenCalledWith(T, RUN, USER);
    expect(chatAskFromToolCalls([{ name: "mcp__growth__growth__start_channel_work", status: "ok", output_preview: JSON.stringify(r) }])).toEqual(r.request);
  });

  it.each([
    ["autopilot_off", /Autopilot is off/],
    ["daily_cap", /used up/],
    ["no_active_goals", /no active goal/],
  ] as const)("reports %s and asks for no review", async (why, say) => {
    deps.admission.mockResolvedValue(why);
    const r = await run(ctx());
    expect(r.status).toBe(why);
    expect(r.say).toMatch(say);
    expect(r.request).toBeUndefined();
    expect(chatAskFromToolCalls([{ name: "growth__start_channel_work", status: "ok", output_preview: JSON.stringify(r) }])).toBeNull();
  });

  it("does not stack a second ask on one still queued or running, and says the new ask is not in it", async () => {
    deps.pending.mockResolvedValue({ id: "rev-0", key: "chat:other" });
    const r = await run(ctx());
    expect(r.status).toBe("already_queued");
    expect(r.say).toMatch(/this ask is not in it/);
  });

  it("refuses when the founder's message cannot be read, or is not theirs", async () => {
    deps.founderWords.mockRejectedValueOnce(new Error("db down"));
    await expect(run(ctx())).rejects.toMatchObject({ code: "start_channel_work_unavailable" });
    deps.founderWords.mockResolvedValueOnce(null);
    await expect(run(ctx())).rejects.toMatchObject({ code: "start_channel_work_unavailable" });
    expect(deps.admission).not.toHaveBeenCalled();
  });

  it("a failed admission read throws: nothing is promised", async () => {
    deps.admission.mockRejectedValue(new Error("settings unreadable"));
    await expect(run(ctx())).rejects.toThrow("settings unreadable");
  });

  it.each([
    ["another agent", { agent_slug: "operator" }],
    ["a goal review (not chat)", { run_trigger: "a2a" }],
    ["a Slack DM", { run_trigger: "slack" }],
    ["not the founder's order (a member, or the staff console)", { founder_chat_order: false }],
    ["an unverified founder order", { founder_order_unverified: true }],
    ["a page-capture turn", { untrusted_context: true }],
    ["a screenshot turn", { captured_page_context: true }],
    ["a shadow or draft run", { writes_suppressed: true }],
    ["no run", { run_id: undefined }],
  ])("refuses %s", async (_why, over) => {
    await expect(run(ctx(over as Partial<ToolContext>))).rejects.toMatchObject({ code: "start_channel_work_unavailable" });
    expect(deps.founderWords).not.toHaveBeenCalled();
  });

  it("rejects malformed channel names", async () => {
    await expect(run(ctx(), { ask: "x", channels: ["Instagram Ads!"] })).rejects.toThrow();
  });
});
