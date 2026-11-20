import { describe, it, expect, vi } from "vitest";
import { routeSlackCustomAgentMention, type SlackMentionDeps } from "../custom-agent-mention";
import { customAgentPausedReply, planRefusalText } from "@/services/agents/custom-agent-chat";

const args = {
  tenant_id: "t1",
  team_id: "T1",
  channel_id: "C1",
  thread_ts: "1.0",
  original_ts: "1.0",
  event_id: "Ev1",
  raw_text: "<@UBOT> @Standup Bot what shipped?",
  sanitized_text: "@Standup Bot what shipped?",
  user: "U1",
  ingested_event_id: "ie1",
  event_type: "app_mention",
  slack_trace_id: "slk_Ev1",
};
const agent = { id: "ag", slug: "c-aaaaaaaa01", name: "Standup Bot", status: "active" };

function deps(over: Partial<SlackMentionDeps> = {}) {
  return {
    resolve: vi.fn(async () => ({ kind: "run" as const, agent, task: "what shipped?" })),
    enqueueAgentRun: vi.fn(async () => ({ run_id: "run-1" })),
    postMessage: vi.fn(async () => {}),
    claimReply: vi.fn(async () => true),
    afterRouted: vi.fn(async () => {}),
    isCreditsError: () => false,
    warn: () => {},
    ...over,
  };
}

describe("routeSlackCustomAgentMention", () => {
  it("no match => none (operator path untouched), nothing enqueued or posted", async () => {
    const d = deps({ resolve: vi.fn(async () => null) });
    expect(await routeSlackCustomAgentMention(d, args)).toBe("none");
    expect(d.enqueueAgentRun).not.toHaveBeenCalled();
    expect(d.postMessage).not.toHaveBeenCalled();
  });

  it("active agent: enqueued as that slug with Slack routing + the global event key, reply slot claimed", async () => {
    const d = deps();
    expect(await routeSlackCustomAgentMention(d, args)).toBe("routed");
    expect(d.enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "c-aaaaaaaa01",
        tenant_id: "t1",
        trigger: "slack",
        cron_dedupe_key: "slack:Ev1",
        payload: expect.objectContaining({
          task_description: "what shipped?",
          slack: expect.objectContaining({ channel_id: "C1", thread_ts: "1.0", event_id: "Ev1", team_id: "T1" }),
        }),
      }),
    );
    expect(d.claimReply).toHaveBeenCalledWith("t1", "Ev1");
    expect(d.afterRouted).toHaveBeenCalled();
  });

  it("paused agent: the plain reply, no run", async () => {
    const d = deps({ resolve: vi.fn(async () => ({ kind: "paused" as const, agent })) });
    expect(await routeSlackCustomAgentMention(d, args)).toBe("paused");
    expect(d.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Standup Bot is paused. Resume it on its Agent Builder page." }));
    expect(customAgentPausedReply("Standup Bot")).toBe("Standup Bot is paused. Resume it on its Agent Builder page.");
    expect(d.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("Free tenant: the typed refusal is posted", async () => {
    const err = Object.assign(new Error("plan"), { code: "plan_upgrade_required", required_tier: "starter", agent_slug: "c-aaaaaaaa01" });
    const d = deps({ enqueueAgentRun: vi.fn(async () => { throw err; }) });
    expect(await routeSlackCustomAgentMention(d, args)).toBe("refused");
    expect(d.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: planRefusalText() }));
  });

  it("an unexpected enqueue error or a failed reply claim falls through to the normal path", async () => {
    expect(await routeSlackCustomAgentMention(deps({ enqueueAgentRun: vi.fn(async () => { throw new Error("db"); }) }), args)).toBe("none");
    expect(await routeSlackCustomAgentMention(deps({ claimReply: vi.fn(async () => false) }), args)).toBe("none");
  });
});
