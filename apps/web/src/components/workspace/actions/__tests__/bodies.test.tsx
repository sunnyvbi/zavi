// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as api from "@/lib/api";
import { postDraftSaveSchema } from "@zavi/shared";
import { ACTION_TYPES } from "@/lib/workspace/actionTypes";
import { ACTION_BODY } from "../registry";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";
import { AdReviewEditing } from "../ads/AdReviewEditing";
import { AdPublishingBlocker } from "../ads/AdPublishingBlocker";
import { editedAdReviewModel } from "../ads/editedAdReviewModel";
import { adReviewModel } from "../ads/adReviewModel";
import { CHANNELS, type AdReviewResponse } from "@zavi/shared";
import { ChannelSurface } from "../ChannelSurface";
import { ActionSection } from "../ActionSection";
import { AD_CONNECTIONS_URL } from "@/lib/workspace/tabUrl";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("saved advertising review controls", () => {
  const review: AdReviewResponse = {
    review: { creatives: [{ title: "Saved title" }], revision: "a".repeat(64) },
    editable: true, limitations: [], connection_blocker: null,
    fields: [{ key: "ad_text", label: "Ad text", value: "Saved copy", kind: "multiline", optional: false }],
  };
  const model = adReviewModel(makeAction("create_ad", { channel_slug: "meta_ads", body: { ad_review: review.review ?? undefined } }));
  it.each(["light", "dark"])("preserves the persisted value and hides approval during editing in %s mode", (theme) => {
    const onSave = vi.fn(async () => true);
    render(<div className={theme}><AdReviewEditing model={model} review={review} onSave={onSave}><button type="button">Approve ad</button></AdReviewEditing></div>);
    fireEvent.click(screen.getByRole("button", { name: "Edit ad" }));
    expect(screen.queryByRole("button", { name: "Approve ad" })).toBeNull();
    expect(screen.getByLabelText("Ad text").getAttribute("disabled")).toBeNull();
    fireEvent.change(screen.getByLabelText("Ad text"), { target: { value: "Revised copy" } });
    expect(screen.getByRole("dialog", { name: /^Edit ad: / })).toBeTruthy();
    fireEvent.submit(screen.getByRole("form", { name: "Edit ad proposal" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ revision: "a".repeat(64), changes: { ad_text: "Revised copy" }, request_id: expect.any(String) }));
  });
  it("cancel discards edits, and a proposal with no dates shows no schedule box rather than an empty one", () => {
    const view = render(<AdReviewEditing model={model} review={review} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit ad" }));
    fireEvent.change(screen.getByLabelText("Ad text"), { target: { value: "Discard this" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit ad" }));
    expect(screen.getByLabelText("Ad text")).toHaveProperty("value", "Saved copy");
    view.rerender(<AdReviewEditing model={model} review={review} onSave={vi.fn()} readOnly />);
    expect(screen.queryByRole("form", { name: "Edit ad proposal" })).toBeNull();
    expect(screen.queryByTestId("ad-schedule")).toBeNull();
    expect(screen.queryByText(/No schedule was supplied/)).toBeNull();
    view.rerender(<AdReviewEditing model={{ ...model, schedule: { start: "2026-11-10", end: null } }} review={review} onSave={vi.fn()} readOnly />);
    expect(screen.getByTestId("ad-schedule-starts").textContent).toContain("Nov");
    expect(screen.getByTestId("ad-schedule-ends").textContent).toContain("Not set");
  });
  it("updates the matching creative, accepts incomplete URLs safely, and clears stale source-post content", () => {
    const multi = { ...model, creatives: [{ title: "First" }, { title: "Second", target_url: "https://example.com" }] };
    const fields: AdReviewResponse["fields"] = [
      { key: "ads.1.title", label: "Title", value: "Second", kind: "text", optional: false },
      { key: "ads.1.target_url", label: "Destination", value: "https://example.com", kind: "url", optional: false },
    ];
    const edited = editedAdReviewModel(multi, fields, { "ads.1.title": "New second", "ads.1.target_url": "htt" });
    expect(edited.creatives[0].title).toBe("First");
    expect(edited.creatives[1].title).toBe("New second");
    expect(edited.creatives[1].target_url).toBeUndefined();
    const sources: AdReviewResponse["fields"] = [{ key: "creative.post_urn", label: "Post", value: "urn:li:share:1", kind: "text", optional: false }];
    expect(editedAdReviewModel(multi, sources, { "creative.post_urn": "urn:li:share:2" }).creatives).toEqual([]);
  });
  it("links a verified reconnect failure to integrations without inventing a blocker for warnings", () => {
    const action = makeAction("create_ad", { exec_status: "failed", exec_bucket: "needs_founder", exec_fix: "reconnect", exec_fix_text: "reconnect Meta Ads in Settings" });
    const view = render(<AdPublishingBlocker action={action} />);
    expect(screen.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe(AD_CONNECTIONS_URL);
    view.rerender(<AdPublishingBlocker action={{ ...action, exec_status: null, blocking: true }} />);
    expect(screen.queryByTestId("ad-publishing-blocker")).toBeNull();
  });
});

function handlers(): ActionHandlers {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() };
}

describe("ACTION_TYPES", () => {
  it("is exactly the 13 locked types, in order", () => {
    expect(ACTION_TYPES).toEqual([
      "text_post",
      "image_post",
      "video_post",
      "reply",
      "send_message",
      "create_ad",
      "update_ad",
      "pause_ad",
      "fix",
      "check",
      "setup",
      "page",
      "other",
    ]);
  });
});

describe("ACTION_BODY", () => {
  it("has one body for every action type and nothing else", () => {
    expect(Object.keys(ACTION_BODY).sort()).toEqual([...ACTION_TYPES].sort());
    for (const t of ACTION_TYPES) expect(typeof ACTION_BODY[t]).toBe("function");
  });

  it.each(ACTION_TYPES)("renders %s as a full card: title, footer, and NO ranking chrome", (t) => {
    const a = FIXTURES[t];
    render(<ChannelActionCard action={a} platform={platformFor(a.channel_slug)} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.closest("[data-action-type]")?.getAttribute("data-action-type")).toBe(t);
    expect(within(card).getByRole("heading", { name: a.title })).toBeTruthy();
    expect(within(card).queryByTestId("action-score")).toBeNull();
    expect(within(card).queryByRole("button", { name: /Why it ranks here/ })).toBeNull();
    expect(within(card).getAllByRole("button").length).toBeGreaterThan(1);
    expect(within(card).queryByTestId("action-evidence")).toBeNull();
    for (const line of ["Read the last 30 posts on the account this run", "The pinned post is 11 months old"]) {
      expect(card.textContent, `raw evidence leaked on ${t}`).not.toContain(line);
    }
    expect((card.textContent ?? "").length).toBeGreaterThan(a.title.length + 20);
  });

  it("renders an unknown type as Other instead of dropping it", () => {
    const a = makeAction("other", { title: "From a newer server" });
    (a as { action_type: string }).action_type = "launch_rocket";
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(screen.getByRole("heading", { name: "From a newer server" })).toBeTruthy();
  });
});

describe("body content", () => {
  it("text post shows the deliverable as the post, and the step body as the why", () => {
    const a = FIXTURES.text_post;
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(within(card).getByTestId("post-text").textContent).toContain("Our rule for product feedback:");
    expect(within(card).getByText(/Numbered, practical posts/)).toBeTruthy();
  });

  it("image post shows the image; a missing one says so", () => {
    render(<ChannelActionCard action={FIXTURES.image_post} handlers={handlers()} />);
    expect(screen.getByRole("img", { name: "Pricing page before and after" })).toBeTruthy();
    expect(screen.queryByTestId("image-missing")).toBeNull();
    cleanup();
    render(<ChannelActionCard action={{ ...FIXTURES.image_post, body: { ...FIXTURES.image_post.body, media: undefined } }} handlers={handlers()} />);
    expect(screen.queryByTestId("media-missing")).toBeNull();
    expect(screen.getByTestId("image-missing").textContent).toContain("text only");
    cleanup();
    render(<ChannelActionCard action={FIXTURES.video_post} handlers={handlers()} />);
    expect(screen.getByTestId("media-missing")).toBeTruthy();
  });

  it("an image that fails to load falls back to the frame, never a broken image", () => {
    render(<ChannelActionCard action={FIXTURES.image_post} handlers={handlers()} />);
    const img = screen.getByRole("img", { name: "Pricing page before and after" });
    fireEvent.error(img);
    expect(screen.queryByRole("img", { name: "Pricing page before and after" })).toBeNull();
    expect(screen.getByTestId("media-missing").textContent).toContain("could not be loaded");
  });

  it("reply shows the post it answers", () => {
    render(<ChannelActionCard action={FIXTURES.reply} handlers={handlers()} />);
    expect(screen.getByTestId(`action-${FIXTURES.reply.id}`).textContent).toContain("@a_prospect: Is there a free tier");
  });

  it("send message shows the recipient and the message", () => {
    render(<ChannelActionCard action={FIXTURES.send_message} platform={platformFor("email_marketing")} handlers={handlers()} />);
    expect(screen.getByTestId("message-recipient").textContent).toContain("Lapsed trials (212)");
    expect(screen.getByTestId("email-box-subject").textContent).toBe("Your project is still here");
    expect(screen.getByTestId("email-box").textContent).toContain("stopped at step two");
  });

  it("blocking actions carry the Do this first chip, and others do not", () => {
    render(<ChannelActionCard action={FIXTURES.fix} handlers={handlers()} />);
    expect(within(screen.getByTestId(`action-${FIXTURES.fix.id}`)).getByText("Do this first")).toBeTruthy();
    cleanup();
    render(<ChannelActionCard action={FIXTURES.check} handlers={handlers()} />);
    expect(screen.queryByText("Do this first")).toBeNull();
  });

  it("shows no ranking panel at all — not the chip, the toggle, or the inputs", () => {
    render(<ChannelActionCard action={FIXTURES.check} handlers={handlers()} />);
    expect(screen.queryByTestId("action-why")).toBeNull();
    expect(screen.queryByTestId("action-score")).toBeNull();
    expect(screen.queryByRole("button", { name: /Why it ranks here/ })).toBeNull();
    expect(document.body.textContent).not.toContain("Fits your plan and goals");
    expect(document.body.textContent).not.toContain("You rejected a similar action before");
  });
});

describe("ad bodies render the exact change read-only", () => {
  it("update_ad shows the before/after table and no editable field", () => {
    render(<ChannelActionCard action={FIXTURES.update_ad} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    expect(within(change).getByText("$40")).toBeTruthy();
    expect(within(change).getByText("$55")).toBeTruthy();
    expect(change.querySelector("input, textarea, [contenteditable]")).toBeNull();
  });

  it("identical rows collapse into chips grouped by match type", () => {
    render(<ChannelActionCard action={FIXTURES.pause_ad} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    expect(within(change).getByText("Any search containing")).toBeTruthy();
    expect(within(change).getByText("cheap tool")).toBeTruthy();
    expect(screen.getByText("Zavi pauses 4 keywords, freeing about $310 a month.")).toBeTruthy();
  });
});

describe("draft card content column", () => {
  function render_() {
    const a = FIXTURES.text_post;
    render(<ChannelActionCard action={a} platform={platformFor(a.channel_slug)} handlers={handlers()} />);
    return screen.getByTestId(`action-${a.id}`);
  }

  it("reads title, then why, then post, and the draft is never inside the title", () => {
    const card = render_();
    const heading = within(card).getByRole("heading", { name: FIXTURES.text_post.title });
    const draft = within(card).getByTestId("post-text");
    const why = within(card).getByText(/Numbered, practical posts/);
    expect(heading.contains(draft), "the draft must not be nested in the title").toBe(false);
    expect(heading.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(why.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("shared action cards across channel surfaces", () => {
  it.each(CHANNELS.filter((channel) => channel.slug !== "email_marketing").map((channel) => [channel.slug, channel.category]))("%s renders its real deliverable through the shared preview layout", (slug, category) => {
    const action = makeAction(category === "paid" ? "create_ad" : "text_post", { channel_slug: slug, body: { step: { body: "A proposal based on the saved channel draft.", deliverable: { kind: category === "paid" ? "ad" : "post", content: "Saved draft content" } } }, how_to: ["Review the saved draft."] });
    render(<ChannelSurface slug={slug}><ActionSection actions={[action]} platform={platformFor(slug)} handlers={handlers()} empty={<p>No work</p>} /></ChannelSurface>);
    const card = screen.getByTestId(`action-${action.id}`);
    expect(card.textContent).toContain("Saved draft content");
    if (category !== "paid") expect(card.textContent).not.toContain("Sponsored");
    const facts = card;
    if (slug === "reddit_organic" || slug === "pinterest_organic") expect(facts.querySelector("[data-testid='ad-cost'], [data-testid='action-cost']")).toBeNull();
    else if (category === "paid") expect(facts.querySelector("[data-testid='ad-cost']")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ready for you" })).toBeTruthy();
  });

  it("drops the Cost row only on Reddit, even when the card carries a cost", () => {
    const withCost = (slug: string) => makeAction("text_post", { channel_slug: slug, body: { cost: "$4", step: { body: "A proposal.", deliverable: { kind: "post", content: "Saved draft content" } } } });
    const reddit = withCost("reddit_organic");
    render(<ChannelSurface slug="reddit_organic"><ChannelActionCard action={reddit} platform={platformFor("reddit_organic")} handlers={handlers()} /></ChannelSurface>);
    expect(screen.getByTestId(`action-${reddit.id}`).textContent).not.toContain("$4");
    cleanup();
    const linkedin = withCost("linkedin_organic");
    render(<ChannelSurface slug="linkedin_organic"><ChannelActionCard action={linkedin} platform={platformFor("linkedin_organic")} handlers={handlers()} /></ChannelSurface>);
    expect(screen.getByTestId("action-kind").parentElement?.textContent).toContain("$4");
  });

  it.each([
    ["a run's Reddit card", { channel_slug: "reddit_organic", run_id: "run-1" }, "From a Zavi run"],
    ["a scan's Reddit reply", { channel_slug: "reddit_organic", run_id: null, body: { step: { body: "A reply.", deliverable: { kind: "reply", content: "Saved draft content", presentation: { type: "reddit_reply", thread_url: "https://www.reddit.com/r/x/comments/1/a/" } } } } }, "Drafted by Zavi from your Reddit scan"],
    ["any other Reddit card", { channel_slug: "reddit_organic", run_id: null }, "Saved channel proposal"],
    ["another channel's run card", { channel_slug: "linkedin_organic", run_id: "run-1" }, "Saved channel proposal"],
  ])("says where %s came from", (_name, over, words) => {
    const action = makeAction("text_post", { body: { step: { body: "A proposal.", deliverable: { kind: "post", content: "Saved draft content" } } }, ...over } as Parameters<typeof makeAction>[1]);
    render(<ChannelSurface slug={action.channel_slug}><ChannelActionCard action={action} platform={platformFor(action.channel_slug)} handlers={handlers()} /></ChannelSurface>);
    fireEvent.click(within(screen.getByTestId(`action-${action.id}`)).getByRole("button", { name: "What it is" }));
    expect(screen.getByTestId("action-provenance").textContent).toBe(`Comes from: ${words}`);
  });

  it.each(CHANNELS.filter((channel) => channel.slug.endsWith("_organic") || channel.slug === "blog").map((channel) => channel.slug))("%s opens the common editor in the card dialog, with no preview pane", (slug) => {
    const action = makeAction("text_post", { channel_slug: slug, body: { text: "Actual draft" } });
    const platform = platformFor(slug);
    render(<ChannelSurface slug={slug}><ChannelActionCard action={action} platform={platform} handlers={handlers()} /></ChannelSurface>);
    const edit = screen.queryByRole("button", { name: "Edit" });
    if (edit) fireEvent.click(edit);
    else {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    }
    const dialog = screen.getByRole("dialog", { name: /^Edit the/ });
    expect(within(dialog).getByLabelText("Edit post")).toBeTruthy();
    expect(within(dialog).queryByRole("complementary")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps the reference section for a creator-only channel surface", () => {
    render(<ChannelSurface slug="instagram_organic"><ActionSection actions={[]} handlers={handlers()} empty={<p>No work</p>} extra={{ position: "after", cards: [<div key="brief">Create a brief</div>] }} /></ChannelSurface>);
    expect(screen.getByRole("region", { name: "Ready for you" }).textContent).toContain("Create a brief");
  });

  it("edits an organic draft in the shared dialog and keeps publishing separate", () => {
    const action = makeAction("image_post", { channel_slug: "instagram_organic", body: { step: { body: "A saved image caption", deliverable: { kind: "post", content: "Original caption" } }, media: { kind: "image", url: "https://example.com/photo.jpg" } } });
    const onPublish = vi.fn(async () => true);
    render(<ChannelSurface slug="instagram_organic"><ChannelActionCard action={action} platform={platformFor("instagram_organic")} handlers={{ ...handlers(), onPublish }} /></ChannelSurface>);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Updated caption" } });
    expect(onPublish).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /^Edit the/ });
    expect(within(dialog).getByLabelText("Edit post")).toHaveProperty("value", "Updated caption");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("post-text").textContent).toBe("Original caption");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Applied caption" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("post-text").textContent).toBe("Applied caption");
    expect(onPublish).not.toHaveBeenCalled();
  });
});

describe("saved organic media editor", () => {
  it("saves the caption, photo, crop and headline then restores the rendered image after remount", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const path = `${id}/22222222-2222-4222-8222-222222222222.jpg`;
    const renderedPath = `${id}/33333333-3333-4333-8333-333333333333.jpg`;
    const revision = "a".repeat(64);
    let stored: { text: string; thread: null; image_path?: string; size?: "square"; headline?: string; rendered_image_path?: string } | null = null;
    const saveRequests: unknown[] = [];
    vi.spyOn(api, "apiFetch").mockImplementation(async (url, options) => {
      if (String(url).endsWith("/post-draft") && options?.method === "PUT") {
        const input = postDraftSaveSchema.parse(JSON.parse(String(options.body)));
        saveRequests.push(input);
        if (!input.content) throw new Error("Expected content");
        stored = { text: input.content.text, thread: null, image_path: input.content.image_path, size: "square", headline: input.content.headline, rendered_image_path: renderedPath };
        return new Response(JSON.stringify({ content: stored, revision: "b".repeat(64) }), { status: 200 });
      }
      const body = String(url).endsWith("/post-draft") ? { content: stored, revision: stored ? "b".repeat(64) : revision, editable: true }
        : String(url).includes("image-url") ? { signed_url: `https://example.com/${String(url).includes("33333333") ? "rendered" : "source"}.jpg` }
        : String(url).endsWith("/photo") ? { image_path: path }
        : { files: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const action = makeAction("image_post", { id, channel_slug: "instagram_organic", body: { text: "Original caption" } });
    const h = handlers();
    const view = render(<ChannelSurface slug="instagram_organic"><ChannelActionCard action={action} platform={platformFor("instagram_organic")} handlers={h} /></ChannelSurface>);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Saved caption" } });
    fireEvent.change(screen.getByLabelText("Upload photo"), { target: { files: [new File(["image"], "photo.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Square 1:1" }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Ready today" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saveRequests[0]).toMatchObject({ revision, content: { text: "Saved caption", image_path: path, size: "square", headline: "Ready today" } });
    expect(h.onApprove).not.toHaveBeenCalled();
    view.unmount();
    render(<ChannelSurface slug="instagram_organic"><ChannelActionCard action={{ ...action, edited_body: stored }} platform={platformFor("instagram_organic")} handlers={h} /></ChannelSurface>);
    expect(screen.getByTestId("post-text").textContent).toBe("Saved caption");
    await waitFor(() => expect(screen.getByRole("img", { name: "Ready today" }).getAttribute("src")).toContain("rendered.jpg"));
  });
});

it("edits ChatGPT schedule hours and seconds in UTC without modifying untouched fields", () => {
  const review: AdReviewResponse = { editable: true, limitations: [], connection_blocker: null,
    review: { revision: "a".repeat(64), creatives: [], schedule: { start: "2026-10-23T14:03:27.000Z", end: "2026-10-24T14:03:27.000Z" } },
    fields: [{ key: "bundle.campaign.end_time", label: "Ends (UTC)", kind: "datetime", value: "2026-10-24T14:03:27", optional: false }],
  };
  const model = adReviewModel(makeAction("create_ad", { channel_slug: "chatgpt_ads", body: { ad_review: review.review! } }));
  const onSave = vi.fn(async () => true);
  render(<AdReviewEditing model={model} review={review} onSave={onSave} />);
  expect(screen.getByTestId("ad-schedule-ends").textContent).toContain("14:03:27 UTC");
  fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
  const input = screen.getByLabelText("Ends (UTC)");
  expect(input.getAttribute("type")).toBe("datetime-local");
  expect(input.getAttribute("step")).toBe("1");
  fireEvent.change(input, { target: { value: "2026-10-23T18:03:27" } });
  fireEvent.submit(screen.getByRole("form", { name: "Edit ad proposal" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ changes: { "bundle.campaign.end_time": "2026-10-23T18:03:27" } }));
});

it("keeps each ChatGPT image with its own copy instead of overlaying the card thumbnail", () => {
  const review = { creatives: [
    { title: "First", image_url: "https://example.com/first.jpg" },
    { title: "Second", image_url: "https://example.com/second.jpg" },
  ] };
  const result = adReviewModel(makeAction("create_ad", { channel_slug: "chatgpt_ads", body: { ad_review: review, media: { kind: "image", url: "https://example.com/second.jpg" } } }));
  expect(result.creatives).toEqual(review.creatives);
});
