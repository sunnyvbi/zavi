import { describe, expect, it } from "vitest";
import { extractQuestionText } from "../question-text";
import { isLiveStateQuestion } from "../live-state-classify";
import { extractAskText } from "@/agents/research/persist-evidence";

describe("extractQuestionText", () => {
  it("reads a Slack run's words from payload.slack.text so the live-state gate can fire", () => {
    const payload = {
      event_type: "app_mention",
      ingested_event_id: "evt",
      slack: { channel_id: "C1", event_id: "Ev1", team_id: "T1", user: "U1", text: "are we live in Georgia right now?" },
    };
    expect(extractQuestionText(payload)).toBe("are we live in Georgia right now?");
    expect(isLiveStateQuestion(extractQuestionText(payload))).toBe(true);
  });
  it("reads a Teams run's words from payload.teams.text", () => {
    expect(extractQuestionText({ teams: { conversation_id: "c", text: "is the Meta budget still paused today?" } })).toBe("is the Meta budget still paused today?");
  });
  it("still prefers the server-owned raw text and the flat carriers over slack.text", () => {
    expect(extractQuestionText({ current_user_text_raw: "raw", slack: { text: "slack" } })).toBe("raw");
    expect(extractQuestionText({ task_description: "task", slack: { text: "slack" } })).toBe("task");
  });
  it("returns nothing for a handoff child whose slack is routing-only", () => {
    expect(extractQuestionText({ slack: { channel_id: "C1", thread_ts: "1.2" } })).toBe("");
    expect(extractQuestionText({ slack: { text: "   " } })).toBe("");
  });
  it("is the same reader research uses for its topic key", () => {
    expect(extractAskText).toBe(extractQuestionText);
  });
});
