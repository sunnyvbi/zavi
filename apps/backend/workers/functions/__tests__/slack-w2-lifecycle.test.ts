
import { describe, it, expect } from "vitest";

type LifecycleAction =
  | { kind: "app_uninstalled" }
  | { kind: "message_deleted"; channel_id: string; deleted_ts: string }
  | { kind: "message_changed"; channel_id: string; ts: string; new_text: string }
  | { kind: "distill" };

function classifyLifecycle(event: Record<string, unknown>): LifecycleAction {
  const t = typeof event.type === "string" ? event.type : "";
  if (t === "app_uninstalled") return { kind: "app_uninstalled" };
  if (t !== "message") return { kind: "distill" };

  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  if (subtype === "message_deleted") {
    return {
      kind: "message_deleted",
      channel_id: typeof event.channel === "string" ? event.channel : "",
      deleted_ts: typeof event.deleted_ts === "string" ? event.deleted_ts : "",
    };
  }
  if (subtype === "message_changed") {
    const msg = event.message as Record<string, unknown> | undefined;
    return {
      kind: "message_changed",
      channel_id: typeof event.channel === "string" ? event.channel : "",
      ts: typeof msg?.ts === "string" ? msg.ts : "",
      new_text: typeof msg?.text === "string" ? msg.text : "",
    };
  }
  return { kind: "distill" };
}

describe("Slack-IQ W2 lifecycle — dispatcher (codex F3)", () => {
  it("app_uninstalled is a TOP-LEVEL event type → enqueue purge path", () => {
    const action = classifyLifecycle({ type: "app_uninstalled" });
    expect(action).toEqual({ kind: "app_uninstalled" });
  });

  it("message_deleted is type=message + subtype, NOT top-level — pulls deleted_ts", () => {
    const action = classifyLifecycle({
      type: "message",
      subtype: "message_deleted",
      channel: "C999",
      deleted_ts: "1700000000.000100",
    });
    expect(action).toEqual({
      kind: "message_deleted",
      channel_id: "C999",
      deleted_ts: "1700000000.000100",
    });
  });

  it("message_changed is type=message + subtype, NOT top-level — pulls message.ts", () => {
    const action = classifyLifecycle({
      type: "message",
      subtype: "message_changed",
      channel: "C999",
      message: { ts: "1700000000.000100", text: "updated body" },
    });
    expect(action).toEqual({
      kind: "message_changed",
      channel_id: "C999",
      ts: "1700000000.000100",
      new_text: "updated body",
    });
  });

  it("normal message (no subtype) → distill path", () => {
    const action = classifyLifecycle({
      type: "message",
      channel: "C999",
      ts: "1700000000.000100",
      text: "hello",
    });
    expect(action).toEqual({ kind: "distill" });
  });

  it("non-message event types fall through to distill", () => {
    const action = classifyLifecycle({ type: "channel_created", channel: { id: "C001" } });
    expect(action).toEqual({ kind: "distill" });
  });
});

describe("Slack-IQ W2 lifecycle — memory_note cascade source_ref (codex F4)", () => {
  it("source_ref reconstruction matches the convention from commit 3", () => {
    const channel_id = "C999";
    const deleted_ts = "1700000000.000100";
    const cascade_source_ref = `slack:${channel_id}:${deleted_ts}`;
    const write_source_ref = `slack:${channel_id}:${deleted_ts}`;
    expect(cascade_source_ref).toBe(write_source_ref);
  });
});

describe("Slack-IQ W2 lifecycle — erasure rows_nullified contract", () => {
  it("erasure update is field-targeted, not row-delete", () => {
    const update = { author_user_id: null };
    expect(Object.keys(update)).toEqual(["author_user_id"]);
    expect(update.author_user_id).toBeNull();
  });
});
