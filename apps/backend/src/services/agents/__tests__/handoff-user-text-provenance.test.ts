
import { describe, it, expect } from "vitest";
import { extractUserMessageFromPayload } from "../post-text-trust-guard";

const REAL_USER_WORDS =
  "For UpcarPrivate we don't have Host referral program. Can you create a Host program";
const AGENT_INVENTED_BRIEF =
  "The main Upcar marketplace also has a referral strategy in progress, so this plan should be scoped specifically to UpcarPrivate hosts.";

describe("extractUserMessageFromPayload — handoff provenance", () => {
  it("THE BUG: without provenance, a child payload yields the AGENT's brief as 'the user message'", () => {
    const childPayloadPreFix = {
      slack: { team_id: "T1", channel_id: "C1", event_id: "E1", thread_ts: "1", original_ts: "1" },
      intent: AGENT_INVENTED_BRIEF,
      source: "slack",
      slack_handoff_child: true,
    };
    expect(extractUserMessageFromPayload(childPayloadPreFix)).toBe(AGENT_INVENTED_BRIEF);
  });

  it("THE FIX: current_user_text_raw wins over the agent-authored intent", () => {
    const childPayload = {
      slack: { team_id: "T1", channel_id: "C1", event_id: "E1", thread_ts: "1", original_ts: "1" },
      intent: AGENT_INVENTED_BRIEF,
      current_user_text_raw: REAL_USER_WORDS,
      source: "slack",
      slack_handoff_child: true,
    };
    expect(extractUserMessageFromPayload(childPayload)).toBe(REAL_USER_WORDS);
  });

  it("wins over every other carrier, not just intent", () => {
    expect(
      extractUserMessageFromPayload({
        current_user_text_raw: REAL_USER_WORDS,
        user_message: "wrapped chat text",
        slack: { text: "some slack text" },
        task_description: "a task",
        intent: AGENT_INVENTED_BRIEF,
      }),
    ).toBe(REAL_USER_WORDS);
  });

  it("a blank / whitespace-only value does NOT hijack the walk", () => {
    expect(
      extractUserMessageFromPayload({ current_user_text_raw: "   ", slack: { text: "real text" } }),
    ).toBe("real text");
    expect(
      extractUserMessageFromPayload({ current_user_text_raw: "", user_message: "chat text" }),
    ).toBe("chat text");
  });

  it("non-string values are ignored (defensive — payload is untyped JSON)", () => {
    for (const bad of [42, null, {}, [], true]) {
      expect(
        extractUserMessageFromPayload({ current_user_text_raw: bad, intent: "fallback" }),
      ).toBe("fallback");
    }
  });

  it("unchanged for every payload shape that has no provenance key", () => {
    expect(extractUserMessageFromPayload({ user_message: "chat" })).toBe("chat");
    expect(extractUserMessageFromPayload({ slack: { text: "slack" } })).toBe("slack");
    expect(extractUserMessageFromPayload({ email: { body: "email" } })).toBe("email");
    expect(extractUserMessageFromPayload({ task_description: "task" })).toBe("task");
    expect(extractUserMessageFromPayload({ intent: "intent" })).toBe("intent");
    expect(extractUserMessageFromPayload({})).toBe("");
    expect(extractUserMessageFromPayload(null)).toBe("");
  });
});
