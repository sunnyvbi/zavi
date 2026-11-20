import { describe, expect, it } from "vitest";
import type { TenantClient } from "@/services/tenant-client";
import { CHAT_CARDS_MAX, UnknownChannelError, chatCardsReply, pickChatCards } from "../chat-cards";

type Pending = { id: string; decision_class: string; home: string; home_channel: string | null; emitted_at: string };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();

function fakeDb(pending: Pending[], channelCards: Array<{ channel_slug: string }> = [], failChannels = false) {
  const reads: string[] = [];
  const db = {
    from(table: string) {
      reads.push(table);
      const data = table === "customer_visible_pending_decisions" ? [...pending].sort((a, b) => (a.emitted_at < b.emitted_at ? -1 : 1)) : channelCards;
      const result = failChannels && table !== "customer_visible_pending_decisions" ? { data: null, error: { message: "boom" } } : { data, error: null };
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => Promise.resolve(result),
      };
      return chain;
    },
  } as unknown as TenantClient;
  return { db, reads };
}

const RAVI: Pending[] = [
  { id: id(1), decision_class: "pm.file_jira_bug", home: "needs_you", home_channel: null, emitted_at: at(7) },
  { id: id(2), decision_class: "google_ads.campaign_budget", home: "growth", home_channel: null, emitted_at: at(17) },
  { id: id(3), decision_class: "google_ads.campaign_budget", home: "growth", home_channel: null, emitted_at: at(16) },
  { id: id(4), decision_class: "pm.file_jira_bug", home: "needs_you", home_channel: null, emitted_at: at(16) },
  { id: id(5), decision_class: "tiktok_ads.create_campaign", home: "channel", home_channel: "tiktok_ads", emitted_at: at(15) },
  { id: id(6), decision_class: "pm.needs_action", home: "needs_you", home_channel: null, emitted_at: at(10) },
  { id: id(7), decision_class: "chief_of_staff.standing_order", home: "needs_you", home_channel: null, emitted_at: at(11) },
  { id: id(8), decision_class: "email.send", home: "needs_you", home_channel: null, emitted_at: at(12) },
];

describe("pickChatCards", () => {
  it("'what needs my approval?' shows the 5 most important: growth first, then the longest waiting", async () => {
    const { db, reads } = fakeDb(RAVI, [{ channel_slug: "linkedin_ads" }, { channel_slug: "linkedin_ads" }, { channel_slug: "pinterest_organic" }]);
    const p = await pickChatCards(db, {});
    expect(p.cards.map((c) => c.id)).toEqual([id(3), id(2), id(1), id(6), id(7)]);
    expect(p.cards).toHaveLength(CHAT_CARDS_MAX);
    expect(p.more).toEqual({ growth: 0, needs_you: 2 });
    expect(new Set(reads)).toEqual(new Set(["customer_visible_pending_decisions", "customer_visible_open_channel_actions"]));
  });

  it("never shows a card that lives on a channel tile; it counts it on that channel's page instead", async () => {
    const { db } = fakeDb(RAVI, [{ channel_slug: "linkedin_ads" }]);
    const p = await pickChatCards(db, {});
    expect(p.cards.map((c) => c.id)).not.toContain(id(5));
    expect(p.channel_pages).toEqual([
      { channel: "linkedin_ads", name: expect.any(String), open: 1, link: "/workspace?tab=channels&channel=linkedin_ads" },
      { channel: "tiktok_ads", name: expect.any(String), open: 1, link: "/workspace?tab=channels&channel=tiktok_ads" },
    ]);
  });

  it("'anything on Google Ads?' shows only Google Ads cards and only the Google Ads page", async () => {
    const { db } = fakeDb(RAVI, [{ channel_slug: "linkedin_ads" }, { channel_slug: "google_ads" }]);
    const p = await pickChatCards(db, { channel: "google_ads" });
    expect(p.cards.map((c) => c.id)).toEqual([id(3), id(2)]);
    expect(p.more).toEqual({ growth: 0, needs_you: 0 });
    expect(p.channel_pages.map((c) => c.channel)).toEqual(["google_ads"]);
  });

  it("a recommended card is shown by id; decided, foreign or channel-tile ids are refused", async () => {
    const { db } = fakeDb(RAVI);
    const foreign = id(99);
    const p = await pickChatCards(db, { decision_ids: [id(2), foreign, id(5), "not-a-uuid"] });
    expect(p.cards.map((c) => c.id)).toEqual([id(2)]);
    expect(p.not_shown).toEqual([foreign, id(5), "not-a-uuid"]);
  });

  it("a bad filter fails closed: an unknown channel is refused, unusable ids show nothing", async () => {
    const { db } = fakeDb(RAVI);
    await expect(pickChatCards(db, { channel: "google_ad" })).rejects.toBeInstanceOf(UnknownChannelError);
    const p = await pickChatCards(db, { decision_ids: ["not-a-uuid"] });
    expect(p.cards).toEqual([]);
    expect(p.not_shown).toEqual(["not-a-uuid"]);
  });

  it("a failed channel-card read still shows the cards, and the reply never calls the channel pages empty", async () => {
    const { db } = fakeDb([], [], true);
    const p = await pickChatCards(db, {});
    expect(p.channel_unread).toBe(true);
    expect(chatCardsReply(p)).toMatch(/could not be counted/);
    const ok = await pickChatCards(fakeDb(RAVI, [], true).db, {});
    expect(ok.cards).toHaveLength(CHAT_CARDS_MAX);
  });

  it("a named id that waits on another channel is reported as waiting, not decided", async () => {
    const { db } = fakeDb(RAVI);
    const p = await pickChatCards(db, { decision_ids: [id(2), id(1)], channel: "google_ads" });
    expect(p.cards.map((c) => c.id)).toEqual([id(2)]);
    expect(p.not_shown).toEqual([]);
    expect(p.other_channel).toEqual([id(1)]);
    expect(chatCardsReply(p)).toMatch(/Still waiting, but not on this channel/);
  });

  it("nothing waiting: no cards, and the reply says so", async () => {
    const { db } = fakeDb([]);
    const p = await pickChatCards(db, {});
    expect(p.cards).toEqual([]);
    expect(chatCardsReply(p)).toMatch(/No growth or Needs-you card is waiting/);
  });
});

describe("chatCardsReply", () => {
  it("tells the model the cards are tappable here and gives the links to write", async () => {
    const { db } = fakeDb(RAVI, [{ channel_slug: "linkedin_ads" }]);
    const reply = chatCardsReply(await pickChatCards(db, {}));
    expect(reply).toMatch(/Showed 5 live approval cards/);
    expect(reply).toContain(`${id(3)} (google_ads.campaign_budget)`);
    expect(reply).toContain("[Needs you](/workspace?tab=needs-you)");
    expect(reply).toContain("(/workspace?tab=channels&channel=linkedin_ads)");
  });
});
