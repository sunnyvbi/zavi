import { describe, expect, it } from "vitest";
import { getChannel } from "@zavi/shared";
import { closePostCardsForPublished, sameText } from "../post-live";

const TEXT = "We added Hawaii and New Jersey.\n\nUpcar is now live in 20 states.";
const post = { id: "p1", tenant_id: "t1", agent_run_id: "r1", channel: "linkedin", externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:1" };

function deps(cards: Array<{ id: string; body: unknown; edited_body?: unknown }>, text: string | null = TEXT) {
  const closed: Array<{ id: string; note: string; key: string }> = [];
  const asked: Array<{ run: string; slug: string }> = [];
  return {
    closed,
    asked,
    d: {
      readPostTexts: async () => (text ? [text] : []),
      readOpenCards: async (_t: string, run: string, slug: string) => {
        asked.push({ run, slug });
        return cards.map((c) => ({ edited_body: null, ...c }));
      },
      close: async (_t: string, id: string, note: string, key: string) => {
        closed.push({ id, note, key });
      },
    },
  };
}

const card = (id: string, content: string) => ({ id, body: { step: { deliverable: { content } } } });

describe("closePostCardsForPublished", () => {
  it("closes the run's open post card whose text went live, with the link", async () => {
    const { d, closed, asked } = deps([card("c1", "We added Hawaii and New Jersey. Upcar is now live in 20 states."), card("c2", "A different post")]);
    expect(await closePostCardsForPublished(post, d)).toBe(1);
    expect(asked).toEqual([{ run: "r1", slug: "linkedin_organic" }]);
    expect(closed).toEqual([{ id: "c1", note: `Posted on ${getChannel("linkedin_organic")?.name}: https://www.linkedin.com/feed/update/urn:li:share:1`, key: "post-live:p1:c1" }]);
  });
  it("matches the founder's edit when they made one", async () => {
    const { d, closed } = deps([{ id: "c1", body: { step: { deliverable: { content: "old words" } } }, edited_body: { step: { deliverable: { content: TEXT } } } }]);
    expect(await closePostCardsForPublished(post, d)).toBe(1);
    expect(closed[0].id).toBe("c1");
  });
  it("matches a staged post the founder edited: the card still says what Zavi first staged", async () => {
    const closed: string[] = [];
    const n = await closePostCardsForPublished(post, {
      readPostTexts: async () => ["New words the founder wrote", TEXT],
      readOpenCards: async () => [{ id: "c1", body: { step: { deliverable: { content: TEXT } } }, edited_body: null }],
      close: async (_t, id) => { closed.push(id); },
    });
    expect(n).toBe(1);
    expect(closed).toEqual(["c1"]);
  });
  it("matches a card edit stored as top-level text", async () => {
    const { d, closed } = deps([{ id: "c1", body: { step: { deliverable: { content: "old" } } }, edited_body: { text: TEXT } }]);
    expect(await closePostCardsForPublished(post, d)).toBe(1);
    expect(closed[0].id).toBe("c1");
  });
  it("leaves a card the founder edited open when the pre-edit text is what went live", async () => {
    const { d, closed } = deps([{ id: "c1", body: { step: { deliverable: { content: TEXT } } }, edited_body: { text: "Different post" } }]);
    expect(await closePostCardsForPublished(post, d)).toBe(0);
    expect(closed).toEqual([]);
  });
  it("an edit that emptied the text still replaces the card's own words", async () => {
    const { d, closed } = deps([{ id: "c1", body: { step: { deliverable: { content: TEXT } } }, edited_body: { text: "" } }]);
    expect(await closePostCardsForPublished(post, d)).toBe(0);
    expect(closed).toEqual([]);
  });
  it("does nothing without a run, a known channel or the published text", async () => {
    const one = deps([card("c1", TEXT)]);
    expect(await closePostCardsForPublished({ ...post, agent_run_id: null }, one.d)).toBe(0);
    expect(await closePostCardsForPublished({ ...post, channel: "myspace" }, one.d)).toBe(0);
    const none = deps([card("c1", TEXT)], null);
    expect(await closePostCardsForPublished(post, none.d)).toBe(0);
    expect([...one.closed, ...none.closed]).toEqual([]);
  });
});

describe("sameText", () => {
  it("folds whitespace only", () => {
    expect(sameText("a  b\nc", "a b c")).toBe(true);
    expect(sameText("A b", "a b")).toBe(false);
    expect(sameText("  ", "")).toBe(false);
  });
});
