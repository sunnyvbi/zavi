import { describe, it, expect, vi } from "vitest";
import {
  handleSlackEngineerFollowup,
  type SlackFollowupDeps,
} from "../slack-pr-followup";

describe("handleSlackEngineerFollowup — courtesy no-op gate", () => {
  function deps(postMessage: SlackFollowupDeps["postMessage"]): SlackFollowupDeps {
    return {
      svc: new Proxy(
        {},
        {
          get() {
            throw new Error("svc must NOT be queried for a courtesy turn");
          },
        },
      ) as unknown as SlackFollowupDeps["svc"],
      enqueueAgentRun: vi.fn(async () => {
        throw new Error("enqueueAgentRun must NOT fire for a courtesy turn");
      }),
      postMessage,
    };
  }

  const baseArgs = {
    tenant_id: "t1",
    team_id: "T1",
    channel_id: "C1",
    thread_ts: "1.2",
    original_ts: "1.3",
    event_id: "ev1",
    text: "thank you",
  };

  for (const text of ["thank you", "thanks!", "thank you so much", "hey", "good morning"]) {
    it(`suppresses "${text}" with a 👍 and no run`, async () => {
      const post = vi.fn(
        async (_a: Parameters<SlackFollowupDeps["postMessage"]>[0]) => {},
      );
      const r = await handleSlackEngineerFollowup(deps(post), {
        ...baseArgs,
        text,
      });
      expect(r).toEqual({ handled: true, action: "courtesy_noop" });
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toMatchObject({
        tenant_id: "t1",
        channel_id: "C1",
        thread_ts: "1.2",
        text: "👍",
      });
    });
  }

  it("an @mention 'thank you' is normalized + suppressed (mention token stripped)", async () => {
    const post = vi.fn(
      async (_a: Parameters<SlackFollowupDeps["postMessage"]>[0]) => {},
    );
    const r = await handleSlackEngineerFollowup(deps(post), {
      ...baseArgs,
      text: "<@U123ABC> thank you",
    });
    expect(r).toEqual({ handled: true, action: "courtesy_noop" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("still terminalizes courtesy_noop even if the 👍 post throws (no fail-open boot)", async () => {
    const post = vi.fn(async () => {
      throw new Error("slack down");
    });
    const r = await handleSlackEngineerFollowup(deps(post), {
      ...baseArgs,
      text: "thanks!",
    });
    expect(r).toEqual({ handled: true, action: "courtesy_noop" });
  });

  it("a real follow-up after gratitude does NOT short-circuit (reaches PR derivation)", async () => {
    const post = vi.fn(async () => {});
    await expect(
      handleSlackEngineerFollowup(deps(post), {
        ...baseArgs,
        text: "thanks, also rename the button to Save",
      }),
    ).rejects.toThrow("svc must NOT be queried for a courtesy turn");
    expect(post).not.toHaveBeenCalled();
  });
});
