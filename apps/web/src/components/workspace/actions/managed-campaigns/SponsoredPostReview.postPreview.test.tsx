// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { ExactChange } from "../ActionCard";
import { ADS_CONNECTION_CHANGED_EVENT, holdCampaignReview } from "./campaignReviewPrefetch";
import type { ActionItem } from "../types";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
const action = { id: "action-1", body: {}, channel_slug: "linkedin_ads" } as ActionItem;
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const ONE = { id: "11", name: "Account one", currency: "USD", funding_source: "provider", account_binding_id: "5b0c3b8e-1d7a-4c39-9a51-0d2f1f6a7e11" };
const TWO = { id: "22", name: "Account two", currency: "USD", funding_source: "provider" };
let accounts: unknown[] = [ONE, TWO];
const review = () => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Company post", post_urn: "urn:li:share:7123456789012345678", country: "US", audience_suggestions: { titles: ["Chief Executive Officer"], seniorities: [], industries: [], staffCountRanges: [] } },
  accounts,
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
});
const DRAFT_POST = "urn:li:share:7123456789012345678";
const UPCAR = "https://www.linkedin.com/feed/update/urn:li:activity:7464457711406182401/";
const OWN = "https://www.linkedin.com/posts/zavi-labs_launch-share-7300000000000000001-AbCd?utm_source=share";
const OTHER = "https://www.linkedin.com/posts/zavi-labs_hiring-share-7300000000000000002-EfGh";
const MISMATCH = "This post was not published by the company page this ad account advertises for, and LinkedIn only promotes posts from that page. Paste the link to one of that page's posts, or choose another ad account. Nothing was created.";
const UNRESOLVED = "Your post shows here once Zavi can read it.";
const CANNOT_CONFIRM = "Zavi could not confirm that Zavi Labs can sponsor this post, so LinkedIn may refuse the ad after Zavi makes the paused campaign. Check that the post is from that page, and that the connected LinkedIn user has the Sponsored Content poster role on it. Nothing can spend without an ad.";
type Pending = { path: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };
let previews: Pending[] = [];
beforeEach(() => {
  previews = [];
  accounts = [ONE, TWO];
  api.mockReset();
  api.mockImplementation((path: string) => {
    if (path.endsWith("/review")) return Promise.resolve(review());
    if (path.includes("/post-preview?")) return new Promise((resolve, reject) => { previews.push({ path, resolve, reject }); });
    return Promise.resolve({ exact_change: { rows: [] } });
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Element.prototype.scrollIntoView = function () {};
});
afterEach(() => cleanup());
const create = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
const postField = () => screen.getByPlaceholderText("https://www.linkedin.com/posts/…") as HTMLInputElement;
const previewCalls = () => api.mock.calls.map(([p]) => p as string).filter(p => p.includes("/post-preview?"));
const prepared = () => api.mock.calls.some(([p]) => (p as string).endsWith("/prepare"));
const lastPreview = (post: string) => previews.filter(p => new URL(p.path, "http://x").searchParams.get("post") === post).at(-1);
async function ready(settle = true) {
  const onApprove = vi.fn().mockResolvedValue(true);
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Use location and language only/ }));
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Checking the post…");
  if (!settle) return onApprove;
  await waitFor(() => expect(lastPreview(DRAFT_POST)).toBeTruthy());
  lastPreview(DRAFT_POST)!.resolve({ post_urn: DRAFT_POST, post_preview: "Company post" });
  await waitFor(() => expect(create().disabled).toBe(false));
  return onApprove;
}
const refusal = (code: string, message: string) => Object.assign(new Error(message), { status: 422, code });
async function accountInUseBecomes(next: unknown[]) {
  accounts = next;
  await act(async () => { window.dispatchEvent(new Event(ADS_CONNECTION_CHANGED_EVENT)); });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Use location and language only/ }));
}

it("refuses another company page's post as soon as it is pasted, before Create is pressed", async () => {
  const approve = await ready();
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(lastPreview(UPCAR)).toBeDefined());
  const query = new URL(lastPreview(UPCAR)!.path, "http://x");
  expect(query.pathname).toBe("/api/channels/linkedin_ads/actions/action-1/post-preview");
  expect(Object.fromEntries(query.searchParams)).toEqual({ post: UPCAR, account_id: "11", account_binding_id: "5b0c3b8e-1d7a-4c39-9a51-0d2f1f6a7e11" });
  lastPreview(UPCAR)!.reject(refusal("linkedin_ads_post_page_mismatch", MISMATCH));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(MISMATCH);
  expect(postField().closest("label")!.contains(alert)).toBe(true);
  expect(postField().getAttribute("aria-invalid")).toBe("true");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  expect(prepared()).toBe(false);
  expect(approve).not.toHaveBeenCalled();
});

it("accepts an lnkd.in short link from Copy link, sends it to Zavi to resolve, and shows the post it leads to", async () => {
  const SHORT = "https://lnkd.in/p/d7CRxdu7";
  await ready();
  fireEvent.change(postField(), { target: { value: "https://lnkd.in.evil.example/p/d7CRxdu7" } });
  expect(create().disabled).toBe(true);
  fireEvent.change(postField(), { target: { value: SHORT } });
  expect(postField().getAttribute("aria-invalid")).toBe("false");
  await waitFor(() => expect(lastPreview(SHORT)).toBeDefined());
  lastPreview(SHORT)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", post_preview: "Zavi Labs launch post" });
  await screen.findByText("Zavi Labs launch post");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(create().disabled).toBe(false);
});

it("shows the resolved text of an own-page post in place of the unresolved notice", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: OWN } });
  expect(screen.getByText(UNRESOLVED)).toBeTruthy();
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", post_preview: "Zavi Labs launch post" });
  await screen.findByText("Zavi Labs launch post");
  expect(screen.queryByText(UNRESOLVED)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(create().disabled).toBe(false);
});

it("does not block a post LinkedIn would not describe, and asks for one preview per settled link", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: OTHER.slice(0, -4) } });
  fireEvent.change(postField(), { target: { value: OTHER } });
  await waitFor(() => expect(lastPreview(OTHER)).toBeDefined());
  expect(previewCalls().filter(p => !p.includes("share-7123456789012345678") && !p.includes("share%3A7123456789012345678"))).toHaveLength(1);
  lastPreview(OTHER)!.resolve({ post_urn: "urn:li:share:7300000000000000002", author: "unknown", post_preview: null });
  await screen.findByText(/LinkedIn did not share this post's text with Zavi/);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(create().disabled).toBe(false);
});

it("keeps the newer link's result when the older link's answer arrives late", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(lastPreview(UPCAR)).toBeDefined());
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", post_preview: "Zavi Labs launch post" });
  await screen.findByText("Zavi Labs launch post");
  lastPreview(UPCAR)!.reject(refusal("linkedin_ads_post_page_mismatch", MISMATCH));
  await new Promise(r => setTimeout(r, 50));
  expect(screen.queryByText(MISMATCH)).toBeNull();
  expect(screen.getByText("Zavi Labs launch post")).toBeTruthy();
  expect(create().disabled).toBe(false);
  fireEvent.change(postField(), { target: { value: OTHER } });
  await waitFor(() => expect(lastPreview(OTHER)).toBeDefined());
  fireEvent.change(postField(), { target: { value: OWN } });
  lastPreview(OTHER)!.resolve({ post_urn: "urn:li:share:7300000000000000002", author: "page", post_preview: "Stale hiring post" });
  await new Promise(r => setTimeout(r, 50));
  expect(screen.queryByText("Stale hiring post")).toBeNull();
});

it("drops a refusal for the ad account that was in use once a reload says another account is in use now", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(lastPreview(UPCAR)).toBeDefined());
  const first = lastPreview(UPCAR)!;
  await accountInUseBecomes([TWO]);
  first.reject(refusal("linkedin_ads_post_page_mismatch", MISMATCH));
  await waitFor(() => expect(lastPreview(UPCAR)).not.toBe(first));
  expect(new URL(lastPreview(UPCAR)!.path, "http://x").searchParams.get("account_id")).toBe("22");
  expect(new URL(lastPreview(UPCAR)!.path, "http://x").searchParams.has("account_binding_id")).toBe(false);
  expect(screen.queryByText(MISMATCH)).toBeNull();
  expect(postField().value).toBe(UPCAR);
});

it("keeps the draft's own preview for the draft's post", async () => {
  await ready();
  await screen.findByText("Company post");
  await waitFor(() => expect(previews.length).toBeGreaterThan(0));
  previews[0].resolve({ post_urn: "urn:li:share:7123456789012345678", author: "page", post_preview: null });
  await new Promise(r => setTimeout(r, 50));
  expect(screen.getByText("Company post")).toBeTruthy();
});

it("stops reading the post when a revised draft fails to load after a warm cache, while the old post preview is still in flight", async () => {
  const warm = { ...action, id: "action-warm", post_revision: "r1" } as ActionItem;
  const path = `${spec.actionReviewPath}/action-warm/review`;
  const busy = Object.assign(new Error("LinkedIn Ads is busy right now. Try again in a few minutes."), { status: 503, code: "linkedin_ads_busy" });
  let reviews = 0;
  api.mockImplementation((p: string) => {
    if (p.endsWith("/review")) return ++reviews === 1 ? Promise.resolve(review()) : Promise.reject(busy);
    if (p.includes("/post-preview?")) return new Promise((resolve, reject) => { previews.push({ path: p, resolve, reject }); });
    return Promise.resolve({ exact_change: { rows: [] } });
  });
  const release = holdCampaignReview(path, "r1");
  await new Promise(r => setTimeout(r, 0));
  const props = { spec, handlers: { onApprove: vi.fn(), onSetStatus: vi.fn(), onRedo: vi.fn() }, onPrepared: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<SponsoredPostReview action={warm} {...props} />);
  const preview = screen.getByRole("complementary", { name: "Preview" });
  expect(within(preview).getByText("Company post")).toBeTruthy();
  await waitFor(() => expect(previews.length).toBe(1));
  rerender(<SponsoredPostReview action={{ ...warm, post_revision: "r2" }} {...props} />);
  expect(within(preview).getByText("Reading the post…")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe(busy.message);
  expect(reviews).toBe(2);
  expect(within(preview).queryByText("Reading the post…")).toBeNull();
  expect(within(preview).getByText("The post preview is not available because the draft did not load.")).toBeTruthy();
  expect(preview.querySelector(".animate-pulse")).toBeNull();
  previews[0].resolve({ post_urn: "urn:li:share:7123456789012345678", author: "page", post_preview: "Stale company post" });
  await new Promise(r => setTimeout(r, 50));
  expect(within(preview).queryByText("Stale company post")).toBeNull();
  expect(within(preview).queryByText("Reading the post…")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create paused campaign" })).toBeNull();
  expect(prepared()).toBe(false);
  release();
});

it("asks LinkedIn once per account and link: a reload that brings back an account already checked reuses its answer", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", post_preview: "Zavi Labs launch post" });
  await screen.findByText("Zavi Labs launch post");
  await accountInUseBecomes([TWO]);
  await waitFor(() => expect(previewCalls().filter(p => p.includes("account_id=22") && p.includes("share-7300000000000000001"))).toHaveLength(1));
  await accountInUseBecomes([ONE, TWO]);
  await screen.findByText("Zavi Labs launch post");
  await new Promise(r => setTimeout(r, 600));
  expect(previewCalls().filter(p => p.includes("account_id=11") && p.includes("share-7300000000000000001"))).toHaveLength(1);
});

it("checks a refused link again when it is pasted back after the founder fixed it on LinkedIn, and lets Create on once LinkedIn reads it", async () => {
  await ready();
  const upcarChecks = () => previews.filter(p => new URL(p.path, "http://x").searchParams.get("post") === UPCAR);
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(upcarChecks()).toHaveLength(1));
  upcarChecks()[0].reject(refusal("linkedin_ads_post_not_found", MISMATCH));
  expect((await screen.findByRole("alert")).textContent).toBe(MISMATCH);
  expect(create().disabled).toBe(true);
  fireEvent.change(postField(), { target: { value: "" } });
  expect(screen.queryByText(MISMATCH)).toBeNull();
  fireEvent.change(postField(), { target: { value: UPCAR } });
  expect(screen.queryByText(MISMATCH)).toBeNull();
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Checking the post…");
  await waitFor(() => expect(upcarChecks()).toHaveLength(2));
  upcarChecks()[1].resolve({ post_urn: "urn:li:activity:7464457711406182401", post_preview: "Fixed post" });
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(screen.queryByText(MISMATCH)).toBeNull();
  fireEvent.change(postField(), { target: { value: OWN } });
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(create().disabled).toBe(false));
  await new Promise(r => setTimeout(r, 600));
  expect(upcarChecks()).toHaveLength(2);
});

it("when LinkedIn is busy or the check fails, says so with a retry and keeps Create off until a retry passes", async () => {
  await ready(false);
  await waitFor(() => expect(previews).toHaveLength(1));
  previews[0].reject(Object.assign(new Error("LinkedIn Ads is busy right now. Try again in a few minutes."), { status: 429, code: "linkedin_ads_http_error" }));
  const retry = await screen.findByRole("button", { name: "Check again" });
  expect(screen.getByRole("alert").textContent).toContain("Zavi could not check this post with LinkedIn just now");
  expect(screen.queryByText(/LinkedIn Ads is busy/)).toBeNull();
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Zavi has to check the post with LinkedIn before it can create the campaign.");
  fireEvent.submit(create().form!);
  await new Promise(r => setTimeout(r, 0));
  expect(prepared()).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(previews).toHaveLength(2));
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  previews[1].resolve({ post_urn: "urn:li:share:7123456789012345678", post_preview: "Company post", author: "page" });
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(screen.queryByTestId("create-blocked-reason")).toBeNull();
});

it.each([
  ["a network failure", () => new Error("Failed to fetch")],
  ["a revoked LinkedIn login", () => Object.assign(new Error("Reconnect LinkedIn"), { status: 401, code: "linkedin_ads_token_revoked" })],
  ["LinkedIn being down", () => Object.assign(new Error("Service unavailable"), { status: 503, code: "linkedin_ads_http_error" })],
])("keeps Create off when a reload moves the campaign to an account whose post check fails with %s", async (_, failure) => {
  await ready();
  await waitFor(() => expect(previews).toHaveLength(1));
  previews[0].resolve({ post_urn: "urn:li:share:7123456789012345678", post_preview: "Company post", author: "page" });
  await waitFor(() => expect(create().disabled).toBe(false));
  await accountInUseBecomes([TWO]);
  await waitFor(() => expect(previews).toHaveLength(2));
  previews[1].reject(failure());
  expect(await screen.findByRole("button", { name: "Check again" })).toBeTruthy();
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  await new Promise(r => setTimeout(r, 0));
  expect(prepared()).toBe(false);
  await accountInUseBecomes([ONE, TWO]);
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(previews).toHaveLength(2);
});

it("asks again after a busy answer instead of remembering it", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.reject(Object.assign(new Error("LinkedIn Ads is busy right now. Try again in a few minutes."), { status: 429, code: "linkedin_ads_http_error" }));
  await new Promise(r => setTimeout(r, 20));
  fireEvent.change(postField(), { target: { value: OTHER } });
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(previews.filter(p => new URL(p.path, "http://x").searchParams.get("post") === OWN)).toHaveLength(2));
});

it("heads the live preview with the post's page, never a page from another link, and only loads an https logo", async () => {
  await ready();
  const card = () => screen.getByRole("article", { name: "LinkedIn post preview" });
  const header = () => card().querySelector("header")!;
  expect(within(header()).queryByText("Account one")).toBeNull();
  expect(within(header()).getByText("Promoted")).toBeTruthy();
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", post_preview: "Zavi Labs launch post", page: { name: "Zavi Labs", logo_url: "javascript:alert(1)" } });
  await within(header()).findByText("Zavi Labs");
  expect(within(header()).queryByText("Account one")).toBeNull();
  expect(header().innerHTML).not.toContain("javascript");
  fireEvent.change(postField(), { target: { value: OTHER } });
  expect(within(header()).queryByText("Zavi Labs")).toBeNull();
  expect(within(header()).queryByText("Account one")).toBeNull();
  await waitFor(() => expect(lastPreview(OTHER)).toBeDefined());
  lastPreview(OTHER)!.resolve({ post_urn: "urn:li:share:7300000000000000002", author: "page", post_preview: "Hiring post", page: { name: null, logo_url: "https://media.licdn.com/logo.png" } });
  await within(header()).findByText("Account one");
  expect(header().querySelector("img")?.getAttribute("src")).toBe("https://media.licdn.com/logo.png");
});

it("never credits a member's post to the ad account's company page", async () => {
  await ready();
  const header = () => screen.getByRole("article", { name: "LinkedIn post preview" }).querySelector("header")!;
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(lastPreview(UPCAR)).toBeDefined());
  lastPreview(UPCAR)!.resolve({ post_urn: "urn:li:activity:7464457711406182401", author: "member", post_preview: "Yesterday, Airbnb announced", page: { name: "Zavi Labs", logo_url: "https://media.licdn.com/logo.png" } });
  await within(header()).findByText("Thought Leader ad");
  expect(within(header()).queryByText("Zavi Labs")).toBeNull();
  expect(within(header()).queryByText("Account one")).toBeNull();
  expect(header().querySelector("[style]")).toBeNull();
  expect(screen.queryByText(/could not confirm/)).toBeNull();
  const createWas = (screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement).disabled;
  for (const author of ["unknown", "other_page"]) {
    fireEvent.change(postField(), { target: { value: author === "unknown" ? OWN : OTHER } });
    const link = author === "unknown" ? OWN : OTHER;
    await waitFor(() => expect(lastPreview(link)).toBeDefined());
    lastPreview(link)!.resolve({ post_urn: "urn:li:share:7300000000000000009", author, author_note: author === "unknown" ? CANNOT_CONFIRM : null, post_preview: `Post by ${author}`, page: { name: "Zavi Labs", logo_url: null } });
    await screen.findByText(`Post by ${author}`);
    expect(within(header()).queryByText("Zavi Labs")).toBeNull();
    expect(within(header()).queryByText("Account one")).toBeNull();
    expect(within(header()).queryByText("Thought Leader ad")).toBeNull();
    expect(!!screen.queryByText(CANNOT_CONFIRM)).toBe(author === "unknown");
    expect((screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement).disabled).toBe(createWas);
  }
});

it("warns beside the post field when Zavi cannot confirm the page can sponsor the post, without blocking Create, and drops the warning for the page's own post", async () => {
  const approve = await ready();
  fireEvent.change(postField(), { target: { value: OTHER } });
  await waitFor(() => expect(lastPreview(OTHER)).toBeDefined());
  expect(screen.queryByText(CANNOT_CONFIRM)).toBeNull();
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Checking the post…");
  fireEvent.submit(create().form!);
  await new Promise(r => setTimeout(r, 0));
  expect(prepared()).toBe(false);
  expect(approve).not.toHaveBeenCalled();
  lastPreview(OTHER)!.resolve({ post_urn: "urn:li:share:7300000000000000002", author: "unknown", author_note: CANNOT_CONFIRM, post_preview: null, page: { name: "Zavi Labs", logo_url: null } });
  const warning = await screen.findByText(CANNOT_CONFIRM);
  expect(warning.getAttribute("role")).toBe("status");
  expect(warning.closest("section")!.contains(postField())).toBe(true);
  expect(screen.queryByText(/Zavi archives what it made/)).toBeNull();
  expect(create().disabled).toBe(false);

  fireEvent.change(postField(), { target: { value: OWN } });
  expect(screen.queryByText(CANNOT_CONFIRM)).toBeNull();
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", author_note: null, post_preview: "Zavi Labs launch post", page: { name: "Zavi Labs", logo_url: null } });
  await screen.findByText("Zavi Labs launch post");
  expect(screen.queryByText(CANNOT_CONFIRM)).toBeNull();

  fireEvent.change(postField(), { target: { value: OTHER } });
  expect(await screen.findByText(CANNOT_CONFIRM)).toBeTruthy();
  expect(previewCalls().filter(p => new URL(p, "http://x").searchParams.get("post") === OTHER)).toHaveLength(1);
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
  expect(prepared()).toBe(true);
});

it("shows the paused-creation note as a neutral card and keeps every sheet field free of the browser's blue focus outline", async () => {
  await ready();
  const note = screen.getByText(/Created paused\./).closest("p")!;
  expect(note.className).not.toContain("ads-sheet-note");
  expect(note.querySelector("img")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Ad account" })).toBeNull();
  expect(postField().className).toContain("outline-none");
  expect(postField().className).toContain("focus:border-ink");
});

it("shows LinkedIn's post-not-found refusal on the post field the moment the link is checked, and never sends prepare", async () => {
  const NOT_FOUND = "LinkedIn could not find this post. Check the link: open the post on LinkedIn, choose … then Copy link to post, and paste it again.";
  const approve = await ready();
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(lastPreview(UPCAR)).toBeDefined());
  lastPreview(UPCAR)!.reject(refusal("linkedin_ads_post_not_found", NOT_FOUND));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(NOT_FOUND);
  expect(postField().closest("label")!.contains(alert)).toBe(true);
  expect(postField().getAttribute("aria-invalid")).toBe("true");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  expect(prepared()).toBe(false);
  expect(approve).not.toHaveBeenCalled();
});

const ORIGINAL_URL = "https://www.linkedin.com/feed/update/urn:li:share:7463260970245758976/";
const REPOST_NOTE = "This link is a repost. LinkedIn will run the original post by Upcar.ai, first posted on 21 May 2026, not the repost. Open the promoted post to check it is the one you want.";

it("says a pasted repost runs the original post, and links the post LinkedIn will promote", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: UPCAR } });
  await waitFor(() => expect(lastPreview(UPCAR)).toBeDefined());
  lastPreview(UPCAR)!.resolve({ post_urn: "urn:li:share:7463260970245758976", repost_note: REPOST_NOTE, author: "page", post_preview: "The original launch post", page: { name: "Upcar.ai", logo_url: null } });
  const preview = await screen.findByRole("note");
  expect(preview.textContent).toBe(REPOST_NOTE);
  const link = screen.getByRole("link", { name: ORIGINAL_URL }) as HTMLAnchorElement;
  expect(link.href).toBe(ORIGINAL_URL);
  expect(link.closest("p")!.textContent).toBe(`LinkedIn will promote this post: ${ORIGINAL_URL}`);
  expect(create().disabled).toBe(false);
});

it("links a post that is not a repost without a repost note", async () => {
  await ready();
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn: "urn:li:share:7300000000000000001", author: "page", post_preview: "Zavi Labs launch post" });
  await screen.findByText("Zavi Labs launch post");
  expect(screen.queryByRole("note")).toBeNull();
  expect((screen.getByRole("link", { name: /feed\/update/ }) as HTMLAnchorElement).href).toBe("https://www.linkedin.com/feed/update/urn:li:share:7300000000000000001/");
});

it.each(["urn:li:share:73/../../evil", "javascript:alert(1)", "urn:li:activity:7464457711406182401"])("builds no link from a post id that is not a share or ugcPost URN (%s)", async (post_urn) => {
  await ready();
  fireEvent.change(postField(), { target: { value: OWN } });
  await waitFor(() => expect(lastPreview(OWN)).toBeDefined());
  lastPreview(OWN)!.resolve({ post_urn, author: "page", post_preview: "Zavi Labs launch post" });
  await screen.findByText("Zavi Labs launch post");
  expect(screen.queryByText(/LinkedIn will promote this post/)).toBeNull();
});

it("the approval card shows the promoted post as a link, and the repost line as text", () => {
  render(<ExactChange rows={[
    { item: "Promoted post", before: "Not chosen", after: ORIGINAL_URL },
    { item: "Pasted link", before: "Not chosen", after: REPOST_NOTE },
    { item: "Campaign", before: "Not created", after: "https://evil.example/x" },
  ]} />);
  const link = screen.getByRole("link", { name: ORIGINAL_URL }) as HTMLAnchorElement;
  expect(link.href).toBe(ORIGINAL_URL);
  expect(link.target).toBe("_blank");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText(REPOST_NOTE).tagName).toBe("SPAN");
});

it("shows the fetched text of the draft's own post when the draft carried only the pick-a-post placeholder", async () => {
  const urn = "urn:li:share:7123456789012345678";
  api.mockImplementation((path: string) => {
    if (path.endsWith("/review")) { const r = review(); r.draft.post_preview = "Pick the company post to promote when you review this draft."; return Promise.resolve(r); }
    if (path.includes("/post-preview?")) return new Promise((resolve, reject) => { previews.push({ path, resolve, reject }); });
    return Promise.resolve({ exact_change: { rows: [] } });
  });
  await ready(false);
  expect(screen.queryByText("Pick the company post to promote when you review this draft.")).toBeNull();
  await waitFor(() => expect(lastPreview(urn)).toBeDefined());
  lastPreview(urn)!.resolve({ post_urn: urn, author: "page", post_preview: "The draft's real post" });
  await screen.findByText("The draft's real post");
});

it("must catch: a new campaign with no post yet never shows the review instruction as the ad's post text", async () => {
  const instruction = "Paste the link to the company post when you review this draft.";
  api.mockImplementation((path: string) => {
    if (path.endsWith("/review")) { const r = review(); delete (r.draft as { post_urn?: string }).post_urn; r.draft.post_preview = instruction; return Promise.resolve(r); }
    if (path.includes("/post-preview?")) return new Promise((resolve, reject) => { previews.push({ path, resolve, reject }); });
    return Promise.resolve({ exact_change: { rows: [] } });
  });
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove: vi.fn(), onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole("checkbox", { name: /Use location and language only/ });
  expect(postField().value).toBe("");
  expect(screen.queryByText(instruction)).toBeNull();
  expect(screen.getByText("Paste the link to a company post to preview it here.")).toBeTruthy();
  fireEvent.change(postField(), { target: { value: OWN } });
  expect(screen.queryByText(instruction)).toBeNull();
  expect(screen.getByText(UNRESOLVED)).toBeTruthy();
});
