
import { describe, it, expect } from "vitest";
import {
  buildChannelIntroEnqueueArgs,
  channelIntroText,
  shouldPostChannelIntro,
} from "../slack-channel-intro";

const BOT = "Ubot";
const HUMAN = "Uhuman";

describe("channelIntroText — team-facing copy", () => {
  it("names Zavi and explains @-mention here", () => {
    const t = channelIntroText();
    expect(t).toContain("Zavi");
    expect(t).toContain("@-mention");
  });
  it("contains no em-dashes (house style)", () => {
    expect(channelIntroText()).not.toContain("—");
  });
});

describe("shouldPostChannelIntro — only when a human invites OUR bot", () => {
  it("TRUE when a human invites the bot to a channel", () => {
    expect(
      shouldPostChannelIntro(
        { type: "member_joined_channel", user: BOT, inviter: HUMAN, channel: "C1" },
        BOT,
      ),
    ).toBe(true);
  });

  it("FALSE for a programmatic self-join (no inviter) — the auto-join indexing path", () => {
    expect(
      shouldPostChannelIntro(
        { type: "member_joined_channel", user: BOT, channel: "C1" },
        BOT,
      ),
    ).toBe(false);
  });

  it("FALSE when someone OTHER than the bot joins (a real human joining)", () => {
    expect(
      shouldPostChannelIntro(
        { type: "member_joined_channel", user: HUMAN, inviter: HUMAN, channel: "C1" },
        BOT,
      ),
    ).toBe(false);
  });

  it("FALSE for non-join event types", () => {
    expect(
      shouldPostChannelIntro(
        { type: "message", user: BOT, inviter: HUMAN, channel: "C1" },
        BOT,
      ),
    ).toBe(false);
  });

  it("FALSE (fail-closed) when bot_user_id is unknown", () => {
    expect(
      shouldPostChannelIntro(
        { type: "member_joined_channel", user: BOT, inviter: HUMAN, channel: "C1" },
        null,
      ),
    ).toBe(false);
  });

  it("FALSE when the inviter is somehow the bot itself (belt-and-suspenders)", () => {
    expect(
      shouldPostChannelIntro(
        { type: "member_joined_channel", user: BOT, inviter: BOT, channel: "C1" },
        BOT,
      ),
    ).toBe(false);
  });
});

describe("buildChannelIntroEnqueueArgs — Phase B1 durable-outbox enqueue for the channel intro", () => {
  it("shapes a channel_intro row keyed on the ingested Slack event id", () => {
    const args = buildChannelIntroEnqueueArgs({
      tenant_id: "t1",
      team_id: "T1",
      channel_id: "C1",
      ingested_event_id: "ev-abc",
      body: "hi team",
    });
    expect(args).toEqual({
      tenant_id: "t1",
      channel_id: "C1",
      kind: "channel_intro",
      body: "hi team",
      team_id: "T1",
      idempotency_key: "ev-abc:channel_intro",
    });
  });

  it("omits team_id cleanly when absent (single-workspace tenant)", () => {
    const args = buildChannelIntroEnqueueArgs({
      tenant_id: "t1",
      channel_id: "C1",
      ingested_event_id: "ev-xyz",
      body: "hi team",
    });
    expect(args.team_id).toBeUndefined();
    expect(args.idempotency_key).toBe("ev-xyz:channel_intro");
  });

  it("a re-invite (different ingested event id) gets a DIFFERENT idempotency key, so it is NOT swallowed as a dupe", () => {
    const first = buildChannelIntroEnqueueArgs({
      tenant_id: "t1",
      channel_id: "C1",
      ingested_event_id: "ev-1",
      body: "hi team",
    });
    const second = buildChannelIntroEnqueueArgs({
      tenant_id: "t1",
      channel_id: "C1",
      ingested_event_id: "ev-2",
      body: "hi team",
    });
    expect(first.idempotency_key).not.toBe(second.idempotency_key);
  });
});
