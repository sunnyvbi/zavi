import { describe, expect, it } from "vitest";
import { cardFlowReducer, type CardFlow } from "../useCardFlow";
import { channelFamily } from "../family";
import { primaryOf } from "../cardPrimary";
import { cardCopyOf, clipText } from "../cardModel";
import { makeAction } from "../../__tests__/fixtures";

const idle: CardFlow = { s: "idle" };
const words = { network: "X", executed: () => "Live in Meta Ads" };

describe("cardFlowReducer", () => {
  it("goes from copy to confirm and back", () => {
    const waiting = cardFlowReducer(idle, { t: "await", copied: true });
    expect(waiting).toEqual({ s: "confirming", copied: true });
    expect(cardFlowReducer(waiting, { t: "back" })).toEqual(idle);
  });

  it("resolves with a label and returns to idle on undo", () => {
    const done = cardFlowReducer({ s: "working" }, { t: "resolve", tone: "success", label: "Posted on X", undo: true });
    expect(done).toEqual({ s: "resolved", tone: "success", label: "Posted on X", undo: true });
    expect(cardFlowReducer(done, { t: "undo" })).toEqual(idle);
  });

});

describe("channelFamily", () => {
  it("splits paid ad channels from organic, owned and creator channels", () => {
    expect(channelFamily("meta_ads")).toBe("paid");
    expect(channelFamily("chatgpt_ads")).toBe("paid");
    expect(channelFamily("x_organic")).toBe("organic");
    expect(channelFamily("email_marketing")).toBe("organic");
    expect(channelFamily("ugc")).toBe("organic");
    expect(channelFamily("seo")).toBe("organic");
  });
});

describe("primaryOf", () => {
  const handlers = { onSetStatus: () => undefined, onRedo: () => undefined };

  it("posts through Zavi when the channel can publish", () => {
    const a = makeAction("text_post", { body: { step: { deliverable: { kind: "post", content: "hi" } } } });
    const p = primaryOf(a, { ...handlers, onPublish: async () => true }, words);
    expect(p).toMatchObject({ mode: "publish", label: "Post on X", resolved: "Posted on X", undo: false });
  });

  it("copies when it cannot publish and counts blanks on the button", () => {
    const a = makeAction("text_post", { card_kind: "post", primary_label: "Copy post", done_label: "I posted it", body: { step: { deliverable: { kind: "post", content: "Price [FOUNDER: amount]" } } } });
    expect(primaryOf(a, handlers, words)).toMatchObject({ mode: "copy", label: "Copy post (1 blank to fill)", confirm: "I posted it", icon: "copy" });
  });

  it("names an executable change and never offers undo on it", () => {
    const a = makeAction("pause_ad", { channel_slug: "meta_ads", executable: true, primary_label: "Pause" });
    expect(primaryOf(a, { ...handlers, onApprove: () => undefined }, words)).toMatchObject({ mode: "approve", label: "Pause", resolved: "Approved. Sending to X.", undo: false });
  });

  it("opens a link out and waits for the founder to confirm", () => {
    const a = makeAction("fix", { card_kind: "task", primary_label: "Fix on X", done_label: "It's fixed", body: { link: "https://x.com/settings" } });
    expect(primaryOf(a, handlers, words)).toMatchObject({ mode: "external", label: "Fix on X", confirm: "It's fixed", href: "https://x.com/settings", icon: "external" });
  });

  it("names an ad change by its type when the card carries no words", () => {
    const run = { ...handlers, onApprove: () => undefined };
    expect(primaryOf(makeAction("create_ad", { executable: true }), run, words)).toMatchObject({ mode: "approve", label: "Create ad" });
    expect(primaryOf(makeAction("update_ad", { executable: true }), run, words)).toMatchObject({ mode: "approve", label: "Apply change" });
    expect(primaryOf(makeAction("other", { executable: true }), run, words)).toMatchObject({ mode: "approve", label: "Approve" });
    expect(primaryOf(makeAction("pause_ad", { body: { link: "https://ads.google.com/x" } }), handlers, words)).toMatchObject({ mode: "external", label: "Pause" });
    expect(primaryOf(makeAction("other", { body: { link: "https://ads.google.com/x" } }), handlers, words)).toMatchObject({ mode: "external", label: "Review it" });
  });

  it("swaps a generic task word for the platform's own link words", () => {
    const a = makeAction("check", { card_kind: "task", primary_label: "Review it", done_label: "I reviewed it" });
    const platform = { ...words, taskHref: "https://www.linkedin.com/campaignmanager", taskLabel: "Open Campaign Manager" };
    expect(primaryOf(a, handlers, platform)).toMatchObject({ mode: "external", label: "Open Campaign Manager" });
    const own = makeAction("check", { card_kind: "task", primary_label: "Review it", body: { link: "https://example.com/a" } });
    expect(primaryOf(own, handlers, platform)).toMatchObject({ mode: "external", label: "Review it" });
  });

  it("approves a plan in place", () => {
    const a = makeAction("other", { card_kind: "plan", primary_label: "Approve plan", done_label: "Approved" });
    expect(primaryOf(a, handlers, words)).toMatchObject({ mode: "plan", resolved: "Approved", undo: true });
  });
});

describe("card copy length", () => {
  it("keeps the whole title and takes the rest from the server brief", () => {
    const a = makeAction("fix", { title: "A **very** long title", brief: { title: "Short…", lead: "One line.", points: ["a"], steps: [] } });
    expect(cardCopyOf(a)).toMatchObject({ title: "A very long title", fullTitle: "A very long title", lead: "One line.", points: ["a"] });
  });

  it("caps the card title at 100 characters and keeps the whole title for the dialog", () => {
    const long = "word ".repeat(60);
    const a = makeAction("fix", { title: long, body: { step: { body: long } } });
    const copy = cardCopyOf(a);
    expect(copy.title.length).toBeLessThanOrEqual(100);
    expect(copy.title.endsWith("…")).toBe(true);
    expect(copy.fullTitle).toBe(long.trim());
    expect(copy.lead!.length).toBeLessThanOrEqual(170);
    expect(clipText("alpha beta gamma delta", 14)).toBe("alpha beta…");
  });
});
