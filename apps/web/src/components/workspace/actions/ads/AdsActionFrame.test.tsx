import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { AdReviewResponse } from "@zavi/shared";
import * as api from "@/lib/api";
import { ChannelActionCard } from "../ChannelActionCard";
import { makeAction } from "../__tests__/fixtures";
import { platformFor } from "../platforms";
import type { ActionHandlers, ActionItem } from "../types";
import { AdsPresentation } from "./AdsPresentation";
import { editedAdReviewModel } from "./editedAdReviewModel";
import { adReviewModel } from "./adReviewModel";

const review: AdReviewResponse = {
  review: { creatives: [], schedule: { start: null, end: "2026-11-10T23:59:59Z" }, revision: "a".repeat(64) },
  fields: [{ key: "end_time", label: "Ends (UTC)", kind: "date", optional: false, value: "2026-11-10" }],
  editable: true, limitations: [], connection_blocker: null,
};

function handlers(): ActionHandlers {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onReviseAd: vi.fn(async () => true) };
}

function card(action: ActionItem, callbacks = handlers()) {
  const props = { action, handlers: callbacks, platform: platformFor(action.channel_slug) };
  return <AdsPresentation value={props}><ChannelActionCard {...props} /></AdsPresentation>;
}

function scheduleAction() {
  return makeAction("update_ad", { channel_slug: "meta_ads", executable: true, body: {
    change_sentence: "Extend the campaign run.",
    exact_change: { rows: [{ item: "End date", before: "November 5", after: "November 10" }] },
    ad_review: review.review ?? undefined,
  } });
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify(review), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the saved preview read", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const reviewReads = () => vi.mocked(api.apiFetch).mock.calls.filter(([u]) => String(u).includes("/ad-review"));

  it("waits until the card nears the screen", async () => {
    const enters: Array<() => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { enters.push(() => cb([{ isIntersecting: true }])); }
      observe() {}
      disconnect() {}
    });
    render(card(scheduleAction()));
    await act(async () => { await Promise.resolve(); });
    expect(reviewReads()).toHaveLength(0);
    await act(async () => { enters.forEach((enter) => enter()); });
    await waitFor(() => expect(reviewReads()).toHaveLength(1));
  });
});

describe("advertising card review integration", () => {
  it("never labels a LinkedIn Ads card with who does it or how long it takes", () => {
    const founder = makeAction("check", { id: "a-founder", channel_slug: "linkedin_ads", body: { owner: "founder", step: { responsibility: "client", effort: "a few minutes", title: "Check the Insight Tag", body: "Look for the tag." } } });
    const developer = makeAction("fix", { id: "a-dev", channel_slug: "linkedin_ads", body: { owner: "developer", step: { responsibility: "client", effort: "an hour", title: "Add the tag", body: "Paste the snippet." } } });
    const client = makeAction("check", { id: "a-client", channel_slug: "linkedin_ads", body: { step: { responsibility: "client", effort: "5 minutes", title: "Verify the tag", body: "Open Campaign Manager." } } });
    for (const action of [founder, developer, client]) {
      const { container, unmount } = render(card(action));
      expect(container.textContent).toContain(action.body?.step?.body);
      expect(container.textContent).not.toMatch(/You do it|Your developer/);
      expect(container.querySelector("svg.lucide-user-round")).toBeNull();
      unmount();
    }
  });

  it("labels the founder's own step on another ad channel's card", () => {
    const client = makeAction("check", { id: "a-meta", channel_slug: "meta_ads", body: { step: { responsibility: "client", effort: "minutes", title: "Verify the pixel", body: "Open Events Manager." } } });
    const { container } = render(card(client));
    expect(container.textContent).toContain("You do it");
  });

  it("labels a developer's step as your developer's on another ad channel's card", () => {
    const developer = makeAction("fix", { id: "a-google", channel_slug: "google_ads", body: { owner: "developer", step: { responsibility: "client", effort: "hours", title: "Add the tag", body: "Paste the snippet." } } });
    const { container } = render(card(developer));
    expect(container.textContent).toContain("Your developer");
  });

  it("offers schedule-only editing and saves without approval", async () => {
    const action = scheduleAction();
    const callbacks = handlers();
    render(card(action, callbacks));
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule" }));
    const dialog = screen.getByRole("dialog", { name: "Edit the schedule" });
    fireEvent.change(within(dialog).getByLabelText("Ends (UTC)"), { target: { value: "2026-11-12" } });
    expect(screen.queryByTestId("ads-footer")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(callbacks.onReviseAd).toHaveBeenCalledWith(action, expect.objectContaining({ revision: "a".repeat(64), changes: { end_time: "2026-11-12" }, request_id: expect.any(String) })));
    expect(callbacks.onApprove).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(editedAdReviewModel(adReviewModel(action), review.fields, { end_time: "2026-11-12" }).schedule?.end).toBe("2026-11-12T23:59:59Z");
  });

  it.each([{ status: "acted" as const }, { exec_status: "queued" as const }])("keeps schedule edits unavailable for a locked action: %j", async (locked) => {
    render(card({ ...scheduleAction(), ...locked }));
    await waitFor(() => expect(screen.queryByText("Loading saved preview…")).toBeNull());
    expect(screen.queryByRole("button", { name: "Edit schedule" })).toBeNull();
    expect(screen.getByTestId("exact-change").textContent).toContain("November 10");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("asks again whether a card can be edited when its run finishes or fails", async () => {
    let editable = false;
    const fetches = vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify(editable ? review : { ...review, editable: false, fields: [], limitations: ["This ad is being sent to the platform, so it can’t be edited right now."] }), { status: 200 }));
    const callbacks = handlers();
    const action = scheduleAction();
    const view = render(card({ ...action, exec_status: "dispatching" }, callbacks));
    expect(await screen.findByText("This ad is being sent to the platform, so it can’t be edited right now.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit schedule" })).toBeNull();
    editable = true;
    view.rerender(card({ ...action, exec_status: "failed", exec_bucket: "needs_founder", exec_code: "insufficient_credits" }, callbacks));
    expect(await screen.findByRole("button", { name: "Edit schedule" })).toBeTruthy();
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it("offers editing on a failed card when the server allows it", async () => {
    render(card({ ...scheduleAction(), exec_status: "failed", exec_bucket: "needs_founder" }));
    expect(await screen.findByRole("button", { name: "Edit schedule" })).toBeTruthy();
  });

  it.each([
    ["linkedin_ads", false],
    ["meta_ads", true],
  ])("the edit form on %s carries the saving note only outside LinkedIn", async (channel_slug, noted) => {
    const post = { ...review, review: { ...review.review!, schedule: { start: null, end: null } }, fields: [{ key: "creative.post_urn", label: "Source post URN", kind: "text" as const, optional: false, value: "urn:li:share:1" }] };
    vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify(post), { status: 200 }));
    render(card({ ...scheduleAction(), channel_slug }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit( ad)?$/ }));
    const form = await screen.findByRole("form", { name: "Edit ad proposal" });
    expect(within(form).getByText("Source post URN")).toBeTruthy();
    expect(within(form).queryAllByText(/Saving replaces this pending proposal/).length).toBe(noted ? 1 : 0);
  });

  it("says why editing is unavailable", async () => {
    vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify({ ...review, editable: false, fields: [], limitations: ["Only an owner or admin can edit this ad."] }), { status: 200 }));
    render(card(scheduleAction()));
    expect(await screen.findByText("Only an owner or admin can edit this ad.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit schedule" })).toBeNull();
  });

  it("shows the server's reason in the edit dialog when a save fails", async () => {
    const callbacks = { ...handlers(), onReviseAd: vi.fn(async () => { throw new Error("The end date must be after the start date."); }) };
    render(card(scheduleAction(), callbacks));
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule" }));
    const dialog = screen.getByRole("dialog", { name: "Edit the schedule" });
    fireEvent.change(within(dialog).getByLabelText("Ends (UTC)"), { target: { value: "2026-11-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("The end date must be after the start date.")).toBeTruthy();
  });

  it.each(["create_ad", "update_ad", "check"] as const)("retains overflow reasons and caveats on %s cards", (type) => {
    const lines = ["The audience is ready.", "Conversions rose last week.", "The campaign is budget constrained.", "Search demand remains steady.", "Brand queries are excluded.", "Results are estimates and may vary."];
    const action = makeAction(type, { channel_slug: "google_ads", body: {
      change_sentence: "Reach more interested customers.", step: { body: lines.join(" ") },
      ...(type === "create_ad" ? { ad_review: { creatives: [{ title: "Try our product" }] } } : {}),
      ...(type === "update_ad" ? { exact_change: { rows: [{ item: "Budget", before: "$20", after: "$25" }] } } : {}),
      ...(type === "check" ? { intent: "improve" } : {}),
    } });
    render(card(action));
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    const details = screen.getByRole("dialog", { name: "Details" });
    for (const line of lines) expect(details.textContent?.split(line)).toHaveLength(2);
  });

  it("hydrates the schedule card without changing the initial markup", async () => {
    vi.mocked(api.apiFetch).mockImplementation(() => new Promise<Response>(() => {}));
    const content = card(scheduleAction());
    const container = document.createElement("div");
    container.innerHTML = renderToString(content);
    document.body.append(container);
    const initial = container.innerHTML;
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, content, { onRecoverableError }); });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(container.innerHTML).toBe(initial);
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
  });
});

describe("a sponsored LinkedIn post whose Create failed part way", () => {
  const refusal = "LinkedIn did not accept the ad for this post. The paused campaign group and campaign are saved. Choose Try again to finish the remaining steps.";
  const existing = (slug: "linkedin_ads" | "x_ads", target: string, source: string) => {
    const served: AdReviewResponse = { review: { creatives: [{ target_url: target, source }], schedule: { start: null, end: null }, revision: "b".repeat(64) }, fields: [], editable: false, limitations: [], connection_blocker: null };
    vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify(served), { status: 200 }));
    return makeAction("create_ad", { id: `sponsored-${slug}`, channel_slug: slug, executable: true, exec_status: "failed", exec_bucket: "temporary", exec_code: `${slug}_creation_incomplete`, note: refusal, body: { change_sentence: "Sponsor the company post.", ad_review: served.review ?? undefined } });
  };

  it("shows LinkedIn's refusal once with Try again, and no missing-content, missing-media or locked note", async () => {
    const { container } = render(card(existing("linkedin_ads", "https://www.linkedin.com/feed/update/urn:li:share:7001/", "An existing company post")));
    await waitFor(() => expect(screen.queryByText("Loading saved preview…")).toBeNull());
    const text = container.textContent ?? "";
    expect(text.split(refusal)).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
    expect(text).not.toMatch(/has not been supplied|could not be read|may have reached the platform|can’t be edited/);
    expect(screen.queryByTestId("ad-review-locked")).toBeNull();
    expect(screen.queryByRole("article", { name: "LinkedIn post preview" })).toBeNull();
    await waitFor(() => expect(container.textContent).toContain("it cannot be previewed here"));
    expect(container.textContent).toContain("An existing company post");
    expect(container.textContent).not.toContain("This ad runs your company post");
  });

  it("keeps the missing-content note for an existing post on another channel", async () => {
    render(card(existing("x_ads", "https://x.com/i/web/status/123", "An existing X post")));
    await waitFor(() => expect(screen.queryByText("Loading saved preview…")).toBeNull());
    const preview = screen.getByTestId("ads-preview");
    expect(preview.textContent).toContain("The source post’s content has not been supplied for preview.");
    expect(preview.textContent).not.toContain("as it appears on LinkedIn");
  });
});
