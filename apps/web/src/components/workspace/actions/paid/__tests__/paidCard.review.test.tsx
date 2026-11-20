// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as api from "@/lib/api";
import { FamilyCard } from "../../card/FamilyCard";
import { makeAction } from "../../__tests__/fixtures";
import type { ActionHandlers } from "../../types";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
beforeEach(() => {
  vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify({ review: null, fields: [], editable: false, limitations: ["Creative revisions are not supported for this ad."], connection_blocker: null }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(async () => true), onRedo: vi.fn(), onApprove: vi.fn(async () => true) });
const ad = (title: string, image: string) => ({ title, body: `${title} body`, image_url: `https://cdn.example.com/${image}.jpg` });

describe("paid card review", () => {
  it("shows every ad in a multi-ad proposal", () => {
    const a = makeAction("create_ad", { channel_slug: "reddit_ads", body: { ad_review: { creatives: [ad("First ad", "one"), ad("Second ad", "two")] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    const previews = screen.getAllByTestId("ads-preview");
    expect(previews).toHaveLength(2);
    expect(within(previews[1]).getByText("Second ad body")).toBeTruthy();
  });

  it("says when the saved preview could not load, and retries", async () => {
    const fetches = vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response(JSON.stringify({ error: "down" }), { status: 500 }));
    const a = makeAction("create_ad", { channel_slug: "meta_ads", executable: true, body: { ad_review: { creatives: [ad("Rent cars", "car")] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    const alert = await screen.findByTestId("ad-review-error");
    expect(alert.textContent).toContain("may be incomplete");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(fetches.mock.calls.length).toBeGreaterThan(1));
  });

  it("keeps editing limits off a card with nothing to edit", async () => {
    const a = makeAction("pause_ad", { channel_slug: "meta_ads", executable: true, body: { exact_change: { rows: [{ item: "Status", before: "Active", after: "Paused" }] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    await waitFor(() => expect(vi.mocked(api.apiFetch)).toHaveBeenCalled());
    expect(screen.queryByTestId("ad-review-locked")).toBeNull();
  });

  it("shows a budget change under the ad before Approve", () => {
    const a = makeAction("update_ad", { channel_slug: "meta_ads", executable: true, body: { ad_review: { creatives: [ad("Rent cars", "car")] }, exact_change: { rows: [{ item: "Daily budget", before: "$69/day", after: "$830/day" }] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    expect(within(change).getByText("$69/day")).toBeTruthy();
    expect(within(change).getByText("$830/day")).toBeTruthy();
  });

  it("shows a new ad's budget but not its brand-new copy rows under the ad", () => {
    const a = makeAction("create_ad", { channel_slug: "reddit_ads", executable: true, body: { ad_review: { creatives: [ad("Rent cars", "car")] }, exact_change: { rows: [{ item: "Headline", before: "none", after: "Rent cars" }, { item: "Lifetime cap", before: "none", after: "$500" }] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    expect(within(change).getByText("$500")).toBeTruthy();
    expect(within(change).queryByText("none")).toBeNull();
    expect(within(change).queryByText("Headline")).toBeNull();
  });

  it("treats a TikTok launch's 'Nothing yet' like 'none'", () => {
    const a = makeAction("create_ad", { channel_slug: "tiktok_ads", executable: true, body: { ad_review: { creatives: [ad("Rent cars", "car")] }, exact_change: { rows: [{ item: "Ad text", before: "Nothing yet", after: "Rent a car" }, { item: "Daily budget", before: "Nothing yet", after: "$40/day" }] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    expect(within(change).getByText("$40/day")).toBeTruthy();
    expect(within(change).queryByText("Ad text")).toBeNull();
    expect(within(change).queryByText("Nothing yet")).toBeNull();
  });

  it("says a permanent removal was removed, not paused", () => {
    const a = makeAction("pause_ad", { channel_slug: "google_ads", executable: true, status: "acted", exec_status: "executed", body: { exact_change: { rows: [{ item: "Ad group", before: "In your account", after: "Removed for good" }] } } });
    render(<FamilyCard action={a} handlers={handlers()} />);
    expect(screen.getByRole("status").textContent).toContain("Removed from Google Ads");
  });

  it("tells a viewer that an approved change is being made", () => {
    const a = makeAction("update_ad", { channel_slug: "meta_ads", executable: true, exec_status: "queued", body: { exact_change: { rows: [{ item: "Daily budget", before: "$69", after: "$83" }] } } });
    render(<FamilyCard action={a} handlers={handlers()} hideActions />);
    expect(screen.getByTestId("exec-state").textContent).toBe("Zavi is making this change now.");
  });

  it("keeps the receipt, its link, History and the full change on a done ad", () => {
    const a = makeAction("create_ad", {
      channel_slug: "meta_ads", executable: true, status: "acted", exec_status: "executed",
      exec_receipt: { line: "Meta confirmed the ad", url: "https://business.facebook.com/adsmanager" },
      timeline: [{ kind: "proposed", at: "2026-11-01T10:00:00Z" }, { kind: "executed", at: "2026-11-01T11:00:00Z" }],
      body: { ad_review: { creatives: [ad("Rent cars", "car")] }, exact_change: { rows: [{ item: "Daily budget", before: "", after: "$30/day" }] } },
    });
    render(<FamilyCard action={a} handlers={handlers()} />);
    expect(screen.getByTestId("exec-receipt").textContent).toBe("Meta confirmed the ad");
    expect(screen.getByTestId("exec-receipt-link").getAttribute("href")).toBe("https://business.facebook.com/adsmanager");
    expect(within(screen.getByTestId("done-exact-change")).getByText("$30/day")).toBeTruthy();
    fireEvent.click(screen.getByTestId("exec-history"));
    expect(screen.getByRole("dialog", { name: "History" })).toBeTruthy();
  });

  describe("a LinkedIn sponsored post", () => {
    const post = (over: Parameters<typeof makeAction>[1] = {}) => makeAction("create_ad", {
      channel_slug: "linkedin_ads",
      executable: true,
      title: "Review and create your LinkedIn campaign",
      body: {
        intent: "create",
        ad_review: { creatives: [{ target_url: "https://www.linkedin.com/feed/update/urn:li:share:7001/", source: "An existing company post" }], cost: "10.00 USD a day" },
        exact_change: { rows: [
          { item: "Campaign", before: "Not created", after: "Q4 founders · paused" },
          { item: "Daily budget", before: "Not chosen", after: "10.00 USD/day" },
          { item: "Maximum bid per click", before: "Not chosen", after: "2.50 USD" },
          { item: "Funding", before: "Not chosen", after: "Your LinkedIn account bills you directly" },
        ] },
      },
      ...over,
    });
    const reads = (reply: () => Response) => vi.spyOn(api, "apiFetch").mockImplementation(async (path: unknown) => String(path).includes("/post-preview") ? reply() : new Response(JSON.stringify({ review: null, fields: [], editable: false, limitations: [], connection_blocker: null }), { status: 200 }));

    it("shows the post's own text, the money it can spend and where it comes from, with no feed mock-up or change table", async () => {
      const fetches = reads(() => new Response(JSON.stringify({ post_urn: "urn:li:share:7001", post_preview: "Zavi Labs ships the growth agent.", author: "page" }), { status: 200 }));
      const a = post({ id: "li-post-read" });
      render(<FamilyCard action={a} handlers={handlers()} />);
      const card = screen.getByTestId(`action-${a.id}`);
      await waitFor(() => expect(card.textContent).toContain("Zavi Labs ships the growth agent."));
      expect(fetches.mock.calls.some(([path]) => String(path) === `/api/channels/linkedin_ads/actions/${a.id}/post-preview`)).toBe(true);
      const facts = [...card.querySelectorAll("dl > div")].map((row) => row.textContent);
      expect(facts).toEqual(["Daily budget:$10 a day", "Comes from:An existing company post"]);
      expect(card.textContent).not.toContain("Maximum bid per click");
      expect(card.querySelector("p")?.textContent).toBe("Ad· $10 a day");
      expect(card.textContent).toContain("· $10 a day");
      expect(screen.queryByTestId("ads-preview")).toBeNull();
      expect(screen.queryByTestId("exact-change")).toBeNull();
      expect(screen.queryByRole("article", { name: "LinkedIn post preview" })).toBeNull();
    });

    it("after an edit, shows the new daily budget once and not the original proposal's", async () => {
      reads(() => new Response(JSON.stringify({ post_urn: "urn:li:share:7001", post_preview: "Edited." }), { status: 200 }));
      const a = post({ id: "li-post-edited", body: {
        intent: "create",
        ad_review: { creatives: [{ target_url: "https://www.linkedin.com/feed/update/urn:li:share:7001/", source: "An existing company post" }] },
        exact_change: { rows: [
          { item: "Original proposal · Daily budget", before: "Not chosen", after: "10.00 USD/day" },
          { item: "Daily budget", before: "10.00 USD/day", after: "25.00 USD/day" },
        ] },
      } });
      render(<FamilyCard action={a} handlers={handlers()} />);
      const facts = [...screen.getByTestId(`action-${a.id}`).querySelectorAll("dl > div")].map((row) => row.textContent);
      expect(facts).toEqual(["Daily budget:$25 a day", "Comes from:An existing company post"]);
    });

    it("says LinkedIn did not share the text when the post cannot be read, and never the bare placeholder", async () => {
      reads(() => new Response(JSON.stringify({ error: { code: "linkedin_ads_post_unreadable", message: "no" } }), { status: 422 }));
      const a = post({ id: "li-post-unread" });
      render(<FamilyCard action={a} handlers={handlers()} />);
      const card = screen.getByTestId(`action-${a.id}`);
      await waitFor(() => expect(card.textContent).toContain("LinkedIn did not share this post's text with Zavi"));
      expect(card.textContent).not.toMatch(/has not been supplied|Reading the post/);
    });

    it("keeps the full change one click away in What it is", async () => {
      reads(() => new Response(JSON.stringify({ post_urn: "urn:li:share:7001", post_preview: null }), { status: 200 }));
      render(<FamilyCard action={post({ id: "li-post-about" })} handlers={handlers()} />);
      fireEvent.click(screen.getByRole("button", { name: "What it is" }));
      const about = screen.getByRole("dialog", { name: "Details" }).textContent ?? "";
      expect(about).toContain("Your LinkedIn account bills you directly");
      expect(about).toContain("Q4 founders · paused");
      expect(about).toContain("Maximum bid per click");
      expect(about).toContain("2.50 USD");
    });

    it("a copy sheet shows only the copy, its blank marked, and copies without a fill-in panel", async () => {
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const sheet = makeAction("create_ad", {
        id: "li-sheet",
        channel_slug: "linkedin_ads",
        card_kind: "ad_manual",
        title: "Copy sheet ready",
        primary_label: "Copy ad",
        body: { intent: "create", step: { title: "Copy sheet ready", body: "LinkedIn can't take this one from Zavi, so you paste it in.", deliverable: { kind: "ad", content: "Headline: Your spare car can earn more\nBudget: [FOUNDER: daily budget]" } } },
      });
      render(<FamilyCard action={sheet} handlers={handlers()} />);
      const card = screen.getByTestId("action-li-sheet");
      expect(card.querySelector("p")?.textContent).toBe("Ad");
      expect(card.querySelector("mark")?.textContent).toBe("[FOUNDER: daily budget]");
      expect(card.textContent).not.toContain("so you paste it in");
      expect(screen.queryByTestId("blanks-fill")).toBeNull();
      expect(screen.queryByTestId("blanks-pointer")).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: "Copy ad (1 blank to fill)" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("Headline: Your spare car can earn more\nBudget: [FOUNDER: daily budget]"));
      expect(screen.queryByTestId("primary-hint")).toBeNull();
    });
  });
});
