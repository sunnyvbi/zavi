import { describe, it, expect } from "vitest";
import { streamDraftPreview } from "./streamDraftPreview";

describe("streamDraftPreview", () => {
  it("keeps only the prose before a <fundraising> envelope (the reported bug)", () => {
    const raw =
      "Solid base in place. I have ~25 DB rows that fit B2B SaaS / AI / Dev Tools at seed.\n<fundraising>\n{\n  \"investors\": [\n    { \"firm\": \"Precursor Ventures\" }\n  ]\n}\n</fundraising>";
    expect(streamDraftPreview(raw)).toBe(
      "Solid base in place. I have ~25 DB rows that fit B2B SaaS / AI / Dev Tools at seed.",
    );
  });

  it("cuts at a <cite …/> self-closing tag too", () => {
    const raw = "Building the focused shortlist now. <cite memory_anchors=\"company\"/> <fundraising>{}";
    expect(streamDraftPreview(raw)).toBe("Building the focused shortlist now.");
  });

  it("returns empty when the envelope starts immediately (caller falls back to working feed)", () => {
    expect(streamDraftPreview("<plan>\n{ \"steps\": [] }")).toBe("");
    expect(streamDraftPreview("  <fundraising>{}")).toBe("");
  });

  it("cuts as soon as the tag boundary (>) arrives", () => {
    expect(streamDraftPreview("Pulling the list. <fundraising>")).toBe(
      "Pulling the list.",
    );
  });

  it("drops a tag whose name is still streaming (no boundary yet)", () => {
    expect(streamDraftPreview("<plan")).toBe("");
    expect(streamDraftPreview("<")).toBe("");
    expect(streamDraftPreview("Pulling the list. <fundrai")).toBe("Pulling the list.");
    expect(streamDraftPreview("Done.<plan>{}</plan>Next <res")).toBe("Done.\n\nNext");
  });

  it("leaves plain prose with a less-than comparison intact", () => {
    expect(streamDraftPreview("Revenue is < 5% of target so far")).toBe(
      "Revenue is < 5% of target so far",
    );
  });

  it("does NOT cut a streamed autolink <https://…> (name boundary is ':')", () => {
    expect(streamDraftPreview("See the deck at <https://x.com/deck> for more")).toBe(
      "See the deck at <https://x.com/deck> for more",
    );
  });

  it("does NOT cut a generic like Array<T> (uppercase, envelopes are lowercase)", () => {
    expect(streamDraftPreview("Returns an Array<T> of investors")).toBe(
      "Returns an Array<T> of investors",
    );
  });

  it("passes through tag-free prose unchanged", () => {
    expect(streamDraftPreview("Just a normal streamed sentence.")).toBe(
      "Just a normal streamed sentence.",
    );
  });

  it("empty input → empty", () => {
    expect(streamDraftPreview("")).toBe("");
  });

  it("renders the prose AFTER a closed <plan> preamble (operator, every turn)", () => {
    const raw =
      '<plan>{"classify":{"tier":"tier1"},"summary":"Write 4-email host onboarding sequence","steps":["Draft 4 triggered emails"],"files":[]}</plan>\n\nFour assumptions I made visible at the top of each email.\n\n## Email 1 of 4: Welcome';
    expect(streamDraftPreview(raw)).toBe(
      "Four assumptions I made visible at the top of each email.\n\n## Email 1 of 4: Welcome",
    );
  });

  it("keeps prose on BOTH sides of a closed envelope, separated", () => {
    expect(
      streamDraftPreview("Pulling the list.<plan>\n{ \"steps\": [] }\n</plan>Here is what I found."),
    ).toBe("Pulling the list.\n\nHere is what I found.");
  });

  it("still renders NOTHING while the envelope body is mid-stream", () => {
    expect(
      streamDraftPreview('<fundraising>\n{\n  "investors": [\n    { "firm": "Prec'),
    ).toBe("");
    expect(
      streamDraftPreview('Solid base.\n<fundraising>\n{ "investors": [{ "firm": "Prec'),
    ).toBe("Solid base.");
  });

  it("envelope-ONLY output stays empty (pm/cgo — caller falls back to the feed)", () => {
    expect(
      streamDraftPreview('<product_pm_backlog>{"items":[{"t":"x"}]}</product_pm_backlog>'),
    ).toBe("");
  });

  it("drops a self-closing <cite …/> mid-sentence and keeps the rest", () => {
    expect(
      streamDraftPreview('Retention is flat <cite memory_anchors="company"/> across August.'),
    ).toBe("Retention is flat  across August.");
  });

  it("handles several envelopes in one draft", () => {
    expect(
      streamDraftPreview("A<plan>{}</plan>B<research>{}</research>C"),
    ).toBe("A\n\nB\n\nC");
  });
});
