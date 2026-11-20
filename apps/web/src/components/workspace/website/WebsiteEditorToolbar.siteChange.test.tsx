// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WebsiteEditorToolbar } from "./WebsiteEditorToolbar";
import type { SelectedElement } from "./editorProtocol";
import {
  SITE_CHANGE_STARTED,
  SITE_CHANGE_USE_CHAT,
  SiteChangeOffer,
  siteChangeFailureText,
  siteChangeOfferFrom,
  type SiteChangeResult,
} from "./websiteChatEdit";

const heading: SelectedElement = {
  selector: "section.portfolio h2",
  tag: "h2",
  text: "Recent shoots",
  textEditable: true,
  style: {},
};
const REQUEST = 'On the page I\'m looking at, at the element `section.portfolio h2` (it reads "Recent shoots"): add a testimonials section below this';
const CHAT = "That's more than a change to this element, so it needs a change to the site itself.";

afterEach(cleanup);

function mount(onAskAi: (m: string) => Promise<void>, onRequestSiteChange?: (r: string) => Promise<SiteChangeResult>, selected = heading) {
  const view = render(
    <WebsiteEditorToolbar
      selected={selected}
      canUndo={false}
      canRedo={false}
      onApply={() => {}}
      onDelete={() => {}}
      onUndo={() => {}}
      onRedo={() => {}}
      onClose={() => {}}
      onAskAi={onAskAi}
      onRequestSiteChange={onRequestSiteChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Element" }));
  return { input: screen.getByLabelText("Ask AI to change this element") as HTMLInputElement, view };
}

function ask(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

const offering = () =>
  vi.fn(async () => {
    throw new SiteChangeOffer(CHAT, REQUEST);
  });

describe("Ask AI offers a site change for an ask bigger than the element", () => {
  it("shows the offer, starts the scoped change on click, then says it started", async () => {
    const request = vi.fn(async () => ({ ok: true as const }));
    const { input } = mount(offering(), request);
    ask(input, "add a testimonials section below this");
    expect((await screen.findByRole("status")).textContent).toContain(CHAT);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Make this change" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(REQUEST));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(SITE_CHANGE_STARTED));
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "Make this change" })).toBeNull();
  });

  it("a refused change (credits, a busy build) shows why and keeps the offer", async () => {
    const request = vi.fn(async () => ({ ok: false as const, message: "Not enough credits for this change. Top up to make it." }));
    const { input } = mount(offering(), request);
    ask(input, "add a testimonials section below this");
    fireEvent.click(await screen.findByRole("button", { name: "Make this change" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not enough credits for this change. Top up to make it.");
    expect(screen.getByRole("button", { name: "Make this change" })).toBeTruthy();
  });

  it("without a way to start changes here, it points to the chat", async () => {
    const { input } = mount(offering());
    ask(input, "add a testimonials section below this");
    expect((await screen.findByRole("status")).textContent).toBe(`${CHAT} ${SITE_CHANGE_USE_CHAT}`);
    expect(screen.queryByRole("button", { name: "Make this change" })).toBeNull();
  });

  it("typing again or picking another element drops the offer", async () => {
    const { input, view } = mount(offering(), vi.fn(async () => ({ ok: true as const })));
    ask(input, "add a testimonials section below this");
    await screen.findByRole("status");
    fireEvent.change(input, { target: { value: "make it shorter" } });
    expect(screen.queryByRole("status")).toBeNull();

    ask(input, "add a testimonials section below this");
    await screen.findByRole("status");
    view.rerender(
      <WebsiteEditorToolbar
        selected={{ ...heading, selector: "footer p" }}
        canUndo={false}
        canRedo={false}
        onApply={() => {}}
        onDelete={() => {}}
        onUndo={() => {}}
        onRedo={() => {}}
        onClose={() => {}}
        onAskAi={offering()}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});

describe("an answer for an element no longer selected", () => {
  it("is dropped: no offer shows on the newly selected element", async () => {
    let reject: (e: unknown) => void = () => {};
    const pending = vi.fn(() => new Promise<void>((_, rej) => (reject = rej)));
    const { input, view } = mount(pending, vi.fn(async () => ({ ok: true as const })));
    ask(input, "add a testimonials section below this");
    view.rerender(
      <WebsiteEditorToolbar
        selected={{ ...heading, selector: "footer p" }}
        canUndo={false}
        canRedo={false}
        onApply={() => {}}
        onDelete={() => {}}
        onUndo={() => {}}
        onRedo={() => {}}
        onClose={() => {}}
        onAskAi={pending}
        onRequestSiteChange={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
    reject(new SiteChangeOffer(CHAT, REQUEST));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Make this change" })).toBeNull();
    expect(screen.queryByLabelText("Ask AI to change this element")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Element" }));
    expect((screen.getByLabelText("Ask AI to change this element") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("siteChangeOfferFrom / siteChangeFailureText", () => {
  it("reads only a needs_site_change body that carries the request", () => {
    const offer = siteChangeOfferFrom({ code: "needs_site_change", chat: " Bigger change. ", request: REQUEST });
    expect(offer).toBeInstanceOf(SiteChangeOffer);
    expect(offer?.message).toBe("Bigger change.");
    expect(offer?.request).toBe(REQUEST);
    expect(siteChangeOfferFrom({ code: "needs_site_change", chat: "x" })).toBeNull();
    expect(siteChangeOfferFrom({ code: "no_editable_change", request: REQUEST })).toBeNull();
    expect(siteChangeOfferFrom(undefined)).toBeNull();
    expect(siteChangeOfferFrom({ code: "needs_site_change", request: REQUEST })?.message).toMatch(/change to the site itself/);
  });

  it("turns every refine refusal into one line", () => {
    expect(siteChangeFailureText("No build is open.")).toBe("No build is open.");
    expect(siteChangeFailureText({ headline: "Not enough credits for this change.", detail: " Top up to make it." })).toBe(
      "Not enough credits for this change. Top up to make it.",
    );
    expect(siteChangeFailureText({ kind: "old_site_frozen", message: "This app can no longer be changed." })).toBe(
      "This app can no longer be changed.",
    );
  });
});
