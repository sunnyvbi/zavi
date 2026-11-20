import { describe, expect, it } from "vitest";
import { redditPublishTarget } from "../../actions/platforms/_shared";
import { redditStagedCards } from "./stagedPosts";
import type { ActionItem } from "../../actions/types";
import { postContent } from "../../actions/types";

const THREAD = "https://www.reddit.com/r/saas/comments/1abcde/";
const draft = (over: Record<string, unknown>) => ({
  decision_id: "d1", source: "staged", channel: "reddit", text: "Body", thread: null, image_path: null, video_path: null,
  scheduled_at: null, rationale: null, emitted_at: "2026-10-06T00:00:00Z", snoozed_until: null, ...over,
});

describe("redditStagedCards", () => {
  it("a staged post becomes a card that posts to the same subreddit with the same title", () => {
    const [card] = redditStagedCards({ drafts: [draft({ subreddit: "test", title: "Zavi posting test" })], drafts_ok: true }, []);
    expect(card.id).toBe("d1");
    expect(redditPublishTarget(card)).toEqual({ channel: "reddit", fields: { subreddit: "test", title: "Zavi posting test" } });
  });
  it("a staged reply keeps its thread", () => {
    const [card] = redditStagedCards({ drafts: [draft({ channel: "reddit_comment", thread_url: THREAD })], drafts_ok: true }, []);
    expect(card.action_type).toBe("reply");
    expect(redditPublishTarget(card)).toEqual({ channel: "reddit_comment", fields: { thread_url: THREAD } });
    expect(card.channel_slug).toBe("reddit_organic");
  });
  it("keeps both cards when the same reply text targets different threads", () => {
    const other = "https://www.reddit.com/r/saas/comments/2other/";
    const action = { id: "a1", run_id: "run1", action_type: "reply", edited_body: null,
      body: { step: { deliverable: { kind: "post", content: "Body" } }, link: other } };
    const cards = redditStagedCards({ drafts: [draft({ channel: "reddit_comment", thread_url: THREAD })], drafts_ok: true }, [action as unknown as ActionItem]);
    expect(cards.map((card) => card.id)).toEqual(["d1", "a1"]);
    expect(cards[1]).toBe(action);
  });
  it("does not pair a post with the same copy in a different community", () => {
    const action = { id: "a2", run_id: "run1", action_type: "text_post", edited_body: null,
      body: { step: { deliverable: { kind: "post", content: "Body", presentation: { type: "reddit_post", subreddit: "other", title: "Zavi posting test" } } } } };
    const cards = redditStagedCards({ drafts: [draft({ subreddit: "test", title: "Zavi posting test" })], drafts_ok: true }, [action as unknown as ActionItem]);
    expect(cards.map((card) => card.id)).toEqual(["d1", "a2"]);
    expect(cards[1]).toBe(action);
  });
  it("keeps the paired proposal's saved content and revision on the existing action", () => {
    const action = { id: "a3", run_id: "run1", channel_slug: "reddit_organic", action_type: "text_post", edited_body: null,
      body: { step: { deliverable: { kind: "post", content: "Body", presentation: { type: "reddit_post", subreddit: "test", title: "Zavi posting test" } } } } };
    const [card] = redditStagedCards({ drafts: [draft({ subreddit: "test", title: "Zavi posting test", original_text: "Body", text: "Saved reply",
      post_revision: "a".repeat(64), edited_body: { text: "Saved reply", thread: null } })] }, [action as unknown as ActionItem]);
    expect(card.id).toBe("a3");
    expect(card.staged_draft_id).toBe("d1");
    expect(card.post_revision).toBe("a".repeat(64));
    expect(postContent(card).text).toBe("Saved reply");
    expect(redditPublishTarget(card)).toEqual({ channel: "reddit", fields: { subreddit: "test", title: "Zavi posting test" } });
  });
});
