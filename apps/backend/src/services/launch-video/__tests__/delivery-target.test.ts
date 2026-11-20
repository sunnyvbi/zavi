
import { describe, it, expect } from "vitest";
import { resolveVideoDeliveryTarget } from "../delivery-target";

describe("resolveVideoDeliveryTarget", () => {
  it("returns the Slack thread when the run came from Slack", () => {
    const t = resolveVideoDeliveryTarget({
      slack_routing: { channel_id: "C123", thread_ts: "1.2", team_id: "T1" },
      chat_thread_id: "thread-abc",
    });
    expect(t).toEqual({ kind: "slack", channel_id: "C123", thread_ts: "1.2", team_id: "T1" });
  });

  it("returns the chat thread when there is no Slack routing", () => {
    const t = resolveVideoDeliveryTarget({ slack_routing: null, chat_thread_id: "thread-abc" });
    expect(t).toEqual({ kind: "chat", thread_id: "thread-abc" });
  });

  it("prefers Slack over chat when BOTH are present (that is where the person is looking)", () => {
    const t = resolveVideoDeliveryTarget({
      slack_routing: { channel_id: "C123" },
      chat_thread_id: "thread-abc",
    });
    expect(t?.kind).toBe("slack");
  });

  it("returns null when there is no surface at all — the only case that still refuses", () => {
    expect(resolveVideoDeliveryTarget({})).toBeNull();
    expect(resolveVideoDeliveryTarget({ slack_routing: {}, chat_thread_id: null })).toBeNull();
  });

  it("does NOT accept a channel the model named — only host-derived slack_routing", () => {
    const t = resolveVideoDeliveryTarget({ chat_thread_id: "thread-abc" });
    expect(t).toEqual({ kind: "chat", thread_id: "thread-abc" });
  });
});
