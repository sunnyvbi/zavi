import { describe, expect, it } from "vitest";
import { backfillPresentation, needsSiteBuilder, type BackfillRow } from "../card-backfill";

const row = (over: Partial<BackfillRow>): BackfillRow => ({
  id: "a",
  tenant_id: "t",
  channel_slug: "seo",
  action_type: "fix",
  exec_class: null,
  body: { step: { title: "t", body: "b" } },
  ...over,
});

describe("backfillPresentation: the same words the writer stores", () => {
  it("an executable row is executes, with the budget label from its rows", () => {
    const p = backfillPresentation(
      row({
        channel_slug: "meta_ads",
        action_type: "update_ad",
        exec_class: "meta_ads.update_budget",
        body: { step: { title: "t" }, exact_change: { rows: [{ item: "Daily budget", before: "$1", after: "$2" }] } },
      }),
      "unknown",
    );
    expect(p).toMatchObject({ card_kind: "executes", primary_label: "Adjust budget" });
  });

  it("reads the deliverable kind, the link and the step's list lines", () => {
    expect(backfillPresentation(row({ body: { step: { deliverable: { kind: "page_copy", content: "New headline" } } } }), "wordpress").primary_label).toBe("Copy new text");
    expect(
      backfillPresentation(row({ channel_slug: "reddit_organic", action_type: "reply", body: { step: { deliverable: { kind: "comment", content: "Great question" } }, link: "https://www.reddit.com/r/x/" } }), "unknown")
        .primary_label,
    ).toBe("Post on Reddit");
    expect(backfillPresentation(row({ action_type: "check", body: { step: { body: "1. A\n2. B" } } }), "unknown").how_to).toEqual(["A", "B"]);
  });

  it("a copy card with no content is a task (it would open on its done words)", () => {
    expect(backfillPresentation(row({ action_type: "send_message", body: { step: { title: "DM" } } }), "unknown").card_kind).toBe("task");
  });

  it("a malformed body still gets words", () => {
    expect(backfillPresentation(row({ body: null }), "unknown").card_kind).toBe("task");
  });

  it("asks for the site builder only for cards that go onto the founder's site", () => {
    expect(needsSiteBuilder(row({ body: { step: { deliverable: { kind: "article", content: "# Post" } } }, action_type: "text_post" }))).toBe(true);
    expect(needsSiteBuilder(row({ channel_slug: "instagram_organic", action_type: "image_post" }))).toBe(false);
    expect(needsSiteBuilder(row({ action_type: "check" }))).toBe(false);
  });
});
