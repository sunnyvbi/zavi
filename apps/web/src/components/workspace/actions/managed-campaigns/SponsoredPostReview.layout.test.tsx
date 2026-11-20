import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { forgetLinkedInAudienceOptions } from "./LinkedInAudiencePicker";
import { invalidateCampaignReviews } from "./campaignReviewPrefetch";
import type { ActionItem } from "../types";

const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));

const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const OWN = { id: "11", name: "Zavi Labs Ads", currency: "USD", funding_source: "provider", account_binding_id: "5b0c3b8e-1d7a-4c39-9a51-0d2f1f6a7e11" };
const USED = { post_urn: "urn:li:share:7300000000000000001", text: "Zavi Labs ships the growth agent.", date: "2026-10-01T08:00:00.000Z", thumbnail_url: null, label: "Used in an ad" };
const PASTED = "https://www.linkedin.com/posts/zavi-labs_hiring-share-7300000000000000002-EfGh";
const review = () => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Suggested text", country: "US", audience_suggestions: { titles: [], seniorities: [], industries: [], staffCountRanges: [] } },
  accounts: [OWN],
  selected_account_binding_id: null,
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
});

let reviewOf: () => Promise<unknown>;
let postsOf: () => Promise<unknown>;
let targetingOf: () => Promise<unknown>;
let previewOf: () => Promise<unknown>;
let seq = 0;

beforeEach(() => {
  invalidateCampaignReviews();
  forgetLinkedInAudienceOptions();
  window.sessionStorage.clear();
  window.localStorage.clear();
  reviewOf = () => Promise.resolve(review());
  postsOf = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  targetingOf = () => Promise.resolve({ options: [{ urn: "urn:li:seniority:1", name: "Director" }] });
  previewOf = () => Promise.resolve({ post_urn: "urn:li:share:7300000000000000002", author: "page", post_preview: "The post text" });
  api.mockReset();
  api.mockImplementation((path: string) => path.endsWith("/review") ? reviewOf()
    : path.includes("/posts?") ? postsOf()
    : path.includes("/targeting?") ? targetingOf()
    : path.includes("/post-preview?") ? previewOf()
    : Promise.resolve({ exact_change: { rows: [] } }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Element.prototype.scrollIntoView = function () {};
});
afterEach(() => cleanup());

function open() {
  const action = { id: `layout-${++seq}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove: vi.fn().mockResolvedValue(true), onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
}
function gate<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => { release = r; });
  return { promise, release };
}
const aside = () => screen.getByRole("complementary", { name: "Preview" });
const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const pulses = (root: Element) => [...root.querySelectorAll(".animate-pulse")];
const everyPulseRespectsReducedMotion = (root: Element) => pulses(root).every((el) => classes(el).includes("motion-reduce:animate-none"));

it("clamps the form column to the dialog height on desktop so only the form scrolls and the preview stays put", async () => {
  open();
  await screen.findByRole("button", { name: "Create paused campaign" });
  const preview = aside();
  const column = preview.previousElementSibling as HTMLElement;
  const grid = preview.parentElement as HTMLElement;
  const scrollPort = grid.parentElement as HTMLElement;
  expect(classes(scrollPort)).toEqual(expect.arrayContaining(["flex", "flex-col", "overflow-y-auto", "max-h-history-dialog-body"]));
  expect(classes(grid)).toEqual(expect.arrayContaining(["grid", "min-h-0", "grid-cols-1", "shrink-0", "lg:shrink", "lg:grid-cols-action-edit"]));
  expect(classes(column)).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0", "lg:max-h-history-dialog-body"]));
  expect(classes(column).some((c) => /^(lg:)?overflow/.test(c))).toBe(false);
  expect(column.children).toHaveLength(1);
  const shell = column.firstElementChild as HTMLElement;
  expect(classes(shell)).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0"]));
  expect([...shell.children].map((c) => c.tagName)).toEqual(["HEADER", "DIV", "FOOTER"]);
  const [header, scroller, footer] = [...shell.children] as HTMLElement[];
  expect(classes(scroller)).toEqual(expect.arrayContaining(["min-h-0", "flex-none", "lg:flex-1", "lg:overflow-y-auto"]));
  expect(classes(scroller)).not.toContain("overflow-y-auto");
  expect(classes(header)).toContain("shrink-0");
  expect(classes(footer)).toContain("shrink-0");
  expect(scroller.contains(document.querySelector("form"))).toBe(true);
  expect(scroller.contains(screen.getByRole("button", { name: "Create paused campaign" }))).toBe(false);
  expect(footer.contains(screen.getByRole("button", { name: "Create paused campaign" }))).toBe(true);
  expect(scroller.contains(preview)).toBe(false);
  expect(classes(preview)).toEqual(expect.arrayContaining(["min-h-0", "lg:max-h-history-dialog-body", "lg:overflow-y-auto"]));
  expect(classes(preview)).not.toContain("overflow-y-auto");
  expect(within(preview).getByRole("article", { name: "LinkedIn post preview" })).toBeTruthy();
});

it("draws the form and the post card as skeletons while the draft loads, with one status and the loading words for screen readers", async () => {
  const held = gate<unknown>();
  reviewOf = () => held.promise;
  postsOf = () => Promise.resolve({ posts: [], page_name: "Zavi Labs" });
  open();
  const status = screen.getByRole("status");
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(status.textContent).toBe("Reading the draft…");
  expect(classes(status.querySelector(".sr-only")!)).toContain("sr-only");
  expect(within(status).getAllByTestId("ads-review-skeleton-fields")).toHaveLength(2);
  expect(within(status).getAllByTestId("ads-review-skeleton-fields")[0].querySelectorAll(".h-11")).toHaveLength(2);
  expect(within(status).getByTestId("ads-review-skeleton-audience").querySelectorAll(".rounded-2xl").length).toBeGreaterThan(2);
  expect(within(within(status).getByTestId("ads-review-skeleton-post")).getAllByTestId("ads-post-row-skeleton")).toHaveLength(2);
  expect([...status.children].filter((c) => c.getAttribute("aria-hidden") !== "true").map((c) => c.className)).toEqual(["sr-only"]);
  const preview = aside();
  const card = within(preview).getByRole("article", { name: "LinkedIn post preview" });
  const body = within(card).getByTestId("post-preview-skeleton");
  expect(body.getAttribute("aria-busy")).toBe("true");
  expect(body.textContent).toBe("Reading the post…");
  expect(classes(within(body).getByText("Reading the post…"))).toContain("sr-only");
  expect(pulses(body).length).toBeGreaterThanOrEqual(3);
  expect(pulses(card.querySelector("header")!)).toHaveLength(2);
  expect(card.querySelector("header .size-12")).not.toBeNull();
  expect(pulses(within(preview).getByTestId("review-summary-skeleton"))).toHaveLength(6);
  expect(within(preview).getByTestId("review-summary-skeleton").getAttribute("aria-hidden")).toBe("true");
  expect(everyPulseRespectsReducedMotion(document.body)).toBe(true);
  await act(async () => { held.release(review()); await held.promise; });
  await screen.findByRole("button", { name: "Create paused campaign" });
  expect(screen.queryByTestId("ads-review-skeleton")).toBeNull();
  expect(screen.queryByTestId("review-summary-skeleton")).toBeNull();
  expect(within(preview).queryByTestId("post-preview-skeleton")).toBeNull();
  expect(pulses(preview)).toHaveLength(0);
  expect(within(preview).getByText("Suggested text")).toBeTruthy();
  expect(within(preview).getByTestId("review-summary")).toBeTruthy();
});

it("removes every skeleton when the draft fails to load", async () => {
  reviewOf = () => Promise.reject(new Error("LinkedIn Ads is busy right now"));
  open();
  expect(screen.getByTestId("ads-review-skeleton")).toBeTruthy();
  await screen.findByText("LinkedIn Ads is busy right now");
  expect(pulses(document.body)).toHaveLength(0);
  expect(screen.queryByTestId("post-preview-skeleton")).toBeNull();
  expect(screen.getByText("The post preview is not available because the draft did not load.")).toBeTruthy();
});

it("shows post rows with a thumbnail and two lines while the page's posts load, then the real list", async () => {
  const held = gate<unknown>();
  postsOf = () => held.promise;
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Choose from posts" }));
  const loading = await screen.findByTestId("post-picker-loading");
  expect(loading.getAttribute("aria-busy")).toBe("true");
  expect(loading.getAttribute("aria-live")).toBe("polite");
  expect(loading.textContent).toBe("Reading the posts on your company page…");
  expect(classes(within(loading).getByText("Reading the posts on your company page…"))).toContain("sr-only");
  const rows = within(loading).getAllByTestId("ads-post-row-skeleton");
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.getAttribute("aria-hidden")).toBe("true");
    expect(classes(row)).toEqual(expect.arrayContaining(["flex", "items-center", "gap-4", "rounded-2xl", "border", "p-4"]));
    expect(row.querySelectorAll(".size-24")).toHaveLength(1);
    expect(pulses(row)).toHaveLength(5);
  }
  expect(everyPulseRespectsReducedMotion(loading)).toBe(true);
  expect(screen.queryByRole("radiogroup")).toBeNull();
  await act(async () => { held.release({ posts: [USED], page_name: "Zavi Labs" }); await held.promise; });
  const list = await screen.findByRole("radiogroup", { name: "Choose a post to promote" });
  expect(screen.queryByTestId("post-picker-loading")).toBeNull();
  const real = within(list).getByRole("radio");
  for (const shared of ["flex", "items-center", "gap-4", "rounded-2xl", "border", "p-4"]) expect(classes(real)).toContain(shared);
  expect(real.querySelectorAll(".size-24")).toHaveLength(1);
  expect(classes(list)).toContain("gap-3");
  expect(classes(loading)).toContain("gap-3");
});

it("shows option pills while seniority and company size load, then the real options", async () => {
  const held = gate<unknown>();
  targetingOf = () => held.promise;
  open();
  await screen.findByRole("button", { name: "Create paused campaign" });
  const loading = await screen.findAllByTestId("ads-chips-skeleton");
  expect(loading).toHaveLength(2);
  for (const el of loading) {
    expect(el.getAttribute("role")).toBe("status");
    expect(el.textContent).toBe("Loading options…");
    expect(classes(within(el).getByText("Loading options…"))).toContain("sr-only");
    expect(classes(el)).toEqual(expect.arrayContaining(["flex", "flex-wrap", "gap-2", "pt-2"]));
    expect(pulses(el)).toHaveLength(6);
    expect(pulses(el).every((p) => classes(p).includes("h-8") && classes(p).includes("rounded-2xl") && p.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(everyPulseRespectsReducedMotion(el)).toBe(true);
  }
  await act(async () => { held.release({ options: [{ urn: "urn:li:seniority:1", name: "Director" }] }); await held.promise; });
  const options = await screen.findByRole("group", { name: "Seniority options" });
  expect(screen.queryByTestId("ads-chips-skeleton")).toBeNull();
  expect(classes(options)).toEqual(expect.arrayContaining(["flex", "flex-wrap", "gap-2", "pt-2"]));
  expect(classes(within(options).getByRole("button", { name: "Director" }))).toContain("h-8");
});

it("shows the post card skeleton while a pasted post is being read, and never over text that is already real", async () => {
  const held = gate<unknown>();
  previewOf = () => held.promise;
  postsOf = () => Promise.resolve({ posts: [], page_name: "Zavi Labs" });
  open();
  const field = await screen.findByRole("textbox", { name: "The post to promote" });
  const preview = aside();
  expect(within(preview).queryByTestId("post-preview-skeleton")).toBeNull();
  expect(within(preview).getByText("Suggested text")).toBeTruthy();
  fireEvent.change(field, { target: { value: PASTED } });
  const body = within(preview).getByTestId("post-preview-skeleton");
  expect(body.getAttribute("aria-busy")).toBe("true");
  expect(classes(body.firstElementChild!)).toContain("sr-only");
  expect(body.firstElementChild!.textContent).not.toBe("");
  expect(pulses(body).length).toBeGreaterThanOrEqual(3);
  expect(within(preview).queryByText("Suggested text")).toBeNull();
  await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).includes("/post-preview?"))).toBe(true));
  await act(async () => { held.release({ post_urn: "urn:li:share:7300000000000000002", author: "page", post_preview: "The post text" }); await held.promise; });
  expect(await within(preview).findByText("The post text")).toBeTruthy();
  expect(within(preview).queryByTestId("post-preview-skeleton")).toBeNull();
  expect(pulses(preview)).toHaveLength(0);
});

it("draws the broad-audience checkbox in the app theme, level with the first line of its label, on a real checkbox the label toggles", async () => {
  open();
  const box = await screen.findByRole("checkbox", { name: "Show this to everyone in these locations who speaks the language, with no professional audience." }) as HTMLInputElement;
  expect(box.tagName).toBe("INPUT");
  expect(box.type).toBe("checkbox");
  const label = box.closest("label")!;
  expect(classes(label)).toEqual(expect.arrayContaining(["flex", "items-start", "text-sm"]));
  const frame = label.firstElementChild as HTMLElement;
  expect(frame.contains(box)).toBe(true);
  expect(classes(frame)).toEqual(expect.arrayContaining(["relative", "size-6", "shrink-0"]));
  expect(classes(box)).toEqual(expect.arrayContaining(["peer", "absolute", "inset-0", "opacity-0"]));
  const drawn = frame.querySelector("svg")!;
  expect(drawn.getAttribute("aria-hidden")).toBe("true");
  expect(classes(drawn)).toEqual(expect.arrayContaining(["peer-focus-visible:ring-2", "pointer-events-none"]));
  expect(drawn.querySelector("path")).toBeNull();
  expect(drawn.querySelector(".stroke-rule")).not.toBeNull();
  const words = label.lastElementChild as HTMLElement;
  expect(words.textContent).toBe("Show this to everyone in these locations who speaks the language, with no professional audience.");
  expect(classes(words)).toContain("pt-0.5");
  expect(box.checked).toBe(false);
  fireEvent.click(words);
  expect(box.checked).toBe(true);
  expect(frame.querySelector("svg path")).not.toBeNull();
  expect(frame.querySelector("svg .fill-ink")).not.toBeNull();
  expect(frame.querySelector("svg .stroke-cream")).not.toBeNull();
  fireEvent.click(words);
  expect(box.checked).toBe(false);
  expect(frame.querySelector("svg path")).toBeNull();
});
