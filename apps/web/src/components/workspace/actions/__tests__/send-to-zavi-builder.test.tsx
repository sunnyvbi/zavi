// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChannelActionBody, ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { ZAVI_BUILDER_DRAFT_KEY, ZAVI_BUILDER_HREF, takeZaviBuilderDraft } from "../zaviBuilder";
import { makeAction } from "./fixtures";

vi.mock("@/lib/workspace/channelActionsApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace/channelActionsApi")>("@/lib/workspace/channelActionsApi");
  return { ...actual, setChannelActionSteps: vi.fn().mockResolvedValue({ ok: true, steps_done: [] }) };
});

let assigned: string[];
let writeText: ReturnType<typeof vi.fn>;
const realLocation = window.location;

beforeEach(() => {
  assigned = [];
  window.sessionStorage.clear();
  Object.defineProperty(window, "location", {
    value: { search: "", set href(v: string) { assigned.push(v); } },
    configurable: true,
  });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { value: realLocation, configurable: true });
});

function handlers(): ActionHandlers {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() };
}
const card = (a: ChannelActionView, h = handlers()) => {
  render(<ChannelActionCard action={a} platform={platformFor(a.channel_slug)} handlers={h} />);
  return h;
};
const btn = (name: RegExp | string) => screen.getByRole("button", { name });

const zaviSiteTask = (body: Partial<ChannelActionBody> = {}) =>
  makeAction("fix", {
    channel_slug: "blog",
    title: "Add the sitemap to robots.txt",
    body: {
      step: {
        title: "Sitemap",
        body: "Search engines cannot find your sitemap.",
        owner: "developer",
        how_to: ["Open robots.txt on the server.", "Add the Sitemap line."],
        deliverable: { kind: "code", label: "Line to add", content: "Sitemap: https://acme.test/sitemap.xml" },
      },
      owner: "zavi",
      link: "https://acme.test/robots.txt",
      ...body,
    },
    card_kind: "task",
    primary_label: "Send to Zavi",
    done_label: "I sent it to Zavi",
    how_to: ["Press Send to Zavi. Your site was built with Zavi, so Website opens with this change written in."],
  });

describe("a website change on a Zavi-built site goes to Zavi's builder, not an email", () => {
  it("Send to Zavi hands the whole change to the Website chat and never opens the mail app", () => {
    const a = zaviSiteTask();
    const h = card(a);
    fireEvent.click(btn("Send to Zavi"));

    expect(assigned).toEqual([ZAVI_BUILDER_HREF]);
    expect(assigned.some((u) => u.startsWith("mailto:"))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();

    const draft = window.sessionStorage.getItem(ZAVI_BUILDER_DRAFT_KEY) ?? "";
    expect(draft.startsWith("Make this change on my website: Add the sitemap to robots.txt")).toBe(true);
    expect(draft).toContain("Search engines cannot find your sitemap.");
    expect(draft).toContain("1. Open robots.txt on the server.\n2. Add the Sitemap line.");
    expect(draft).toContain("Line to add:\n\nSitemap: https://acme.test/sitemap.xml");
    expect(draft).toContain("Page: https://acme.test/robots.txt");
    expect(draft).not.toMatch(/Press Send to Zavi/);

    fireEvent.click(btn("I sent it to Zavi"));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("steps written only in the card's text still reach the builder when the model gave no how_to", () => {
    card(
      zaviSiteTask({
        step: {
          title: "Sitemap",
          body: "Search engines cannot find your sitemap.\n1. Open robots.txt on the server.\n2. Add the Sitemap line under User-agent.",
          owner: "developer",
        },
      }),
    );
    fireEvent.click(btn("Send to Zavi"));
    const draft = window.sessionStorage.getItem(ZAVI_BUILDER_DRAFT_KEY) ?? "";
    expect(draft).toContain("Open robots.txt on the server.");
    expect(draft).toContain("Add the Sitemap line under User-agent.");
    expect(draft).not.toMatch(/Press Send to Zavi/);
  });

  it("the model saying developer does not bring the email back: no Send to dev, no Email this to your developer", () => {
    card(zaviSiteTask());
    expect(screen.queryByRole("button", { name: /Send to dev/ })).toBeNull();
    fireEvent.click(btn("More actions"));
    expect(screen.queryByRole("menuitem", { name: /Email this to your developer/ })).toBeNull();
    expect(assigned).toEqual([]);
  });

  it("the draft is read once by the Website chat, and blocked storage still opens Website without a mail app", () => {
    card(zaviSiteTask());
    fireEvent.click(btn("Send to Zavi"));
    const first = takeZaviBuilderDraft();
    expect(first).toContain("Add the sitemap to robots.txt");
    expect(takeZaviBuilderDraft()).toBeNull();

    cleanup();
    assigned = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    card(zaviSiteTask());
    fireEvent.click(btn("Send to Zavi"));
    expect(assigned).toEqual([ZAVI_BUILDER_HREF]);
  });

  it("an executable card owned by Zavi is never handed to the builder", () => {
    const a = { ...zaviSiteTask(), executable: true, card_kind: "executes" as const, primary_label: "Open pull request", done_label: "Done" };
    card(a);
    expect(screen.queryByRole("button", { name: "Send to Zavi" })).toBeNull();
    expect(window.sessionStorage.getItem(ZAVI_BUILDER_DRAFT_KEY)).toBeNull();
  });

  it("a site built elsewhere keeps Send to dev and the mail app", () => {
    const a = { ...zaviSiteTask({ owner: "developer" }), primary_label: "Send to dev", done_label: "I sent it to dev" };
    card(a);
    fireEvent.click(btn("Send to dev"));
    expect(assigned).toHaveLength(1);
    expect(assigned[0].startsWith("mailto:?subject=Add%20the%20sitemap%20to%20robots.txt")).toBe(true);
    expect(window.sessionStorage.getItem(ZAVI_BUILDER_DRAFT_KEY)).toBeNull();
  });
});
