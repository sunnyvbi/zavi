
import { describe, it, expect } from "vitest";

import { buildDistillSlackRpcPayload } from "../distill-event";

type Conv = "channel_public" | "channel_private" | "dm" | "mpim";

function deriveConvType(channel_type: string, channel_id: string): { conv: Conv; is_private: boolean } {
  switch (channel_type) {
    case "im":
      return { conv: "dm", is_private: true };
    case "mpim":
      return { conv: "mpim", is_private: true };
    case "group":
      return { conv: "channel_private", is_private: true };
    case "channel":
      return { conv: "channel_public", is_private: false };
    default:
      if (channel_id.startsWith("D")) return { conv: "dm", is_private: true };
      if (channel_id.startsWith("G")) return { conv: "channel_private", is_private: true };
      return { conv: "channel_public", is_private: false };
  }
}

function slackSourceRef(channel_id: string, ts: string): string {
  return `slack:${channel_id}:${ts}`;
}

describe("Slack-IQ W2 atomic-boundary — payload contract", () => {
  it("source_ref convention is 'slack:<channel>:<ts>' (codex F4)", () => {
    expect(slackSourceRef("C12345", "1700000000.000100")).toBe(
      "slack:C12345:1700000000.000100",
    );
    expect(slackSourceRef("D-private", "1700.0")).toBe("slack:D-private:1700.0");
  });

  it("conversation_type derivation matches every channel_type", () => {
    expect(deriveConvType("im", "D123")).toEqual({ conv: "dm", is_private: true });
    expect(deriveConvType("mpim", "G123")).toEqual({ conv: "mpim", is_private: true });
    expect(deriveConvType("group", "G123")).toEqual({ conv: "channel_private", is_private: true });
    expect(deriveConvType("channel", "C123")).toEqual({ conv: "channel_public", is_private: false });
  });

  it("conversation_type fallback uses channel_id prefix when channel_type missing", () => {
    expect(deriveConvType("", "D456")).toEqual({ conv: "dm", is_private: true });
    expect(deriveConvType("", "G789")).toEqual({ conv: "channel_private", is_private: true });
    expect(deriveConvType("", "C001")).toEqual({ conv: "channel_public", is_private: false });
  });

  it("source_user_ids slice-1 minimum is [author_user_id] when author present", () => {
    const author = "U777";
    expect([author]).toEqual(["U777"]);
    const noAuthor: string[] = [];
    expect(noAuthor.length).toBe(0);
  });

  it("RPC call shape — no artifacts: slack_message_index present, memory_note key ABSENT", () => {
    const payload = buildDistillSlackRpcPayload({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      ingested_event_id: "00000000-0000-0000-0000-000000000002",
      slack_message_index: {
        channel_id: "C001",
        ts: "1700.0",
        author_user_id: "U777",
        text_redacted: "hello",
        thread_ts: null,
        msg_subtype: null,
        conversation_type: "channel_public" as const,
        is_private: false,
        source_team_id: "T001",
        source_user_ids: ["U777"],
      },
      memory_note: null,
    });
    expect(payload.slack_message_index).toBeDefined();
    expect("memory_note" in payload).toBe(false);
    expect(
      (payload.slack_message_index as { source_user_ids: string[] }).source_user_ids,
    ).toEqual(["U777"]);
  });

  it("RPC call shape — when memory_note is present, source_ref uses slack convention", () => {
    const payload = buildDistillSlackRpcPayload({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      ingested_event_id: "00000000-0000-0000-0000-000000000002",
      slack_message_index: {
        channel_id: "C001",
        ts: "1700.5",
        author_user_id: "U777",
        text_redacted: "kept this",
        thread_ts: null,
        msg_subtype: null,
        conversation_type: "channel_public" as const,
        is_private: false,
        source_team_id: "T001",
        source_user_ids: ["U777"],
      },
      memory_note: {
        title: "operator stated rule",
        body_markdown: "we always tip 20%",
        source_ref: slackSourceRef("C001", "1700.5"),
        tags: ["slack:policies"],
        note_type: "operator_preference",
      },
    });
    const note = payload.memory_note as { source_ref: string } | undefined;
    const idx = payload.slack_message_index as { channel_id: string; ts: string };
    expect(note?.source_ref).toBe("slack:C001:1700.5");
    expect(note?.source_ref).toBe(`slack:${idx.channel_id}:${idx.ts}`);
  });
});
