
import { describe, it, expect } from "vitest";
import { parseSlackMessageLifecycle } from "../message-lifecycle-parser";

describe("parseSlackMessageLifecycle", () => {
  it("normalizes message_deleted to the deleted message's ts (not event.ts)", () => {
    const event = {
      type: "message",
      subtype: "message_deleted",
      channel: "C123",
      hidden: true,
      deleted_ts: "1699999999.000100",
      ts: "1700000000.000200",
      event_ts: "1700000000.000200",
    };
    expect(parseSlackMessageLifecycle(event)).toEqual({
      kind: "deleted",
      channel_id: "C123",
      source_ts: "1699999999.000100",
    });
  });

  it("normalizes message_changed off nested message.ts/text (not event.ts)", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C123",
      ts: "1700000000.000300",
      message: {
        type: "message",
        ts: "1699999999.000100",
        text: "summarize last 10 bookings",
        edited: { user: "U1", ts: "1700000000.000300" },
      },
    };
    expect(parseSlackMessageLifecycle(event)).toEqual({
      kind: "changed",
      channel_id: "C123",
      source_ts: "1699999999.000100",
      new_text: "summarize last 10 bookings",
    });
  });

  it("falls back to nested message.channel when top-level channel is absent", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      message: { ts: "1699999999.000100", text: "x", channel: "C999" },
    };
    expect(parseSlackMessageLifecycle(event)).toMatchObject({
      kind: "changed",
      channel_id: "C999",
      source_ts: "1699999999.000100",
    });
  });

  it("returns null on missing load-bearing ids (never guesses)", () => {
    expect(
      parseSlackMessageLifecycle({ type: "message", subtype: "message_deleted", channel: "C1" }),
    ).toBeNull();
    expect(
      parseSlackMessageLifecycle({ type: "message", subtype: "message_changed", channel: "C1", message: { text: "x" } }),
    ).toBeNull();
  });

  it("returns null for non-lifecycle events (plain msg, file_share, non-message)", () => {
    expect(parseSlackMessageLifecycle({ type: "message", text: "hi", ts: "1.1" })).toBeNull();
    expect(parseSlackMessageLifecycle({ type: "message", subtype: "file_share", channel: "C1" })).toBeNull();
    expect(parseSlackMessageLifecycle({ type: "reaction_added" })).toBeNull();
    expect(parseSlackMessageLifecycle(null)).toBeNull();
    expect(parseSlackMessageLifecycle(undefined)).toBeNull();
  });

  it("allows an empty edited text (a user can clear a message body)", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C123",
      message: { ts: "1699999999.000100", text: "" },
    };
    expect(parseSlackMessageLifecycle(event)).toEqual({
      kind: "changed",
      channel_id: "C123",
      source_ts: "1699999999.000100",
      new_text: "",
    });
  });

  it("normalizes an EDITED app_mention (top-level edited, no nested message)", () => {
    const event = {
      type: "app_mention",
      user: "U0BC2H60526",
      text: "<@U0B8DU7ATUY> like how can guest  link their turo or other rental account?",
      ts: "1789140585.209219",
      edited: { ts: "1789140616.000000", user: "U0BC2H60526" },
      channel: "C0A8N08J05A",
      event_ts: "1789140585.209219",
    };
    expect(parseSlackMessageLifecycle(event)).toEqual({
      kind: "changed",
      channel_id: "C0A8N08J05A",
      source_ts: "1789140585.209219",
      new_text: "<@U0B8DU7ATUY> like how can guest  link their turo or other rental account?",
    });
  });

  it("an UNEDITED app_mention is still not a lifecycle event", () => {
    expect(
      parseSlackMessageLifecycle({
        type: "app_mention",
        user: "U1",
        text: "<@U0B8DU7ATUY> hello",
        ts: "1789140585.209219",
        channel: "C1",
      }),
    ).toBeNull();
  });
});
