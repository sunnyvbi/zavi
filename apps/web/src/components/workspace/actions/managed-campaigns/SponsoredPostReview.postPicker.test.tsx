import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import type { ActionItem } from "../types";

const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));

const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const OWN = { id: "11", name: "Zavi Labs Ads", currency: "USD", funding_source: "provider", account_binding_id: "5b0c3b8e-1d7a-4c39-9a51-0d2f1f6a7e11" };
const WALLET = { id: "900", name: "Managed account 900", currency: "USD", funding_source: "wallet", account_binding_id: "5b0c3b8e-1d7a-4c39-9a51-0d2f1f6a7e99" };
const USED = { post_urn: "urn:li:share:7300000000000000001", text: "Zavi Labs ships the growth agent.", date: "2026-10-01T08:00:00.000Z", thumbnail_url: "https://media.licdn.com/dms/image/own/0", label: "Used in an ad" };
const PAGE = { post_urn: "urn:li:ugcPost:7390000000000000000", text: null, date: null, thumbnail_url: null, label: "Page post" };
const PASTED = "https://www.linkedin.com/posts/zavi-labs_hiring-share-7300000000000000002-EfGh";

let accounts: unknown[] = [OWN];
let inUse: string | null = null;
let posts: () => Promise<unknown> = () => Promise.resolve({ posts: [], page_name: "Zavi Labs" });
let seq = 0;

beforeEach(() => {
  accounts = [OWN];
  inUse = null;
  posts = () => Promise.resolve({ posts: [], page_name: "Zavi Labs" });
  window.sessionStorage.clear();
  window.localStorage.clear();
  api.mockReset();
  api.mockImplementation((path: string) => {
    if (path.endsWith("/review")) return Promise.resolve({
      draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Suggested text", country: "US", audience_suggestions: { titles: [], seniorities: [], industries: [], staffCountRanges: [] } },
      accounts,
      selected_account_binding_id: inUse,
      suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
    });
    if (path.includes("/posts?")) return posts();
    if (path.includes("/post-preview?")) return Promise.resolve({ post_urn: new URL(path, "http://x").searchParams.get("post"), author: "page", post_preview: "The post text" });
    return Promise.resolve({ exact_change: { rows: [] } });
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Element.prototype.scrollIntoView = function () {};
});
afterEach(() => cleanup());

const create = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
const pasteField = () => screen.getByRole("textbox", { name: /^The post to promote/ }) as HTMLInputElement;
const calls = (part: string) => api.mock.calls.map(([p]) => p as string).filter((p) => p.includes(part));
const prepareBodies = () => api.mock.calls.filter(([p]) => (p as string).endsWith("/prepare")).map(([, init]) => JSON.parse((init as { body: string }).body));

async function open() {
  const onApprove = vi.fn().mockResolvedValue(true);
  const action = { id: `action-${++seq}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /no professional audience/ }));
  return { onApprove, action };
}

async function choosePosts() {
  fireEvent.click(await screen.findByRole("button", { name: "Choose from posts" }));
}

async function chooseList() {
  await choosePosts();
  const group = await screen.findByRole("radiogroup", { name: "Choose a post to promote" });
  await waitFor(() => expect(within(group).getAllByRole("radio")[0].getAttribute("aria-checked")).toBe("true"));
  return group;
}

const settle = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function createCampaign(onApprove: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
  return prepareBodies().at(-1);
}

it("sends prepare the same post value for a picked row as for the same post pasted", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE, { post_urn: "https://evil.example/x", text: "Not a post", date: null, thumbnail_url: null, label: "Page post" }], page_name: "Zavi Labs" });
  const picked = await open();
  expect(calls("/posts?")).toEqual([]);
  const group = await chooseList();
  const rows = within(group).getAllByRole("radio");
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Used in an adZavi Labs ships the growth agent."), expect.stringContaining("Page postPost without text")]);
  expect(calls("/posts?")).toEqual([`/api/channels/linkedin_ads/actions/${picked.action.id}/posts?account_id=11`]);
  expect(screen.queryByRole("textbox", { name: "The post to promote" })).toBeNull();
  expect(prepareBodies()).toEqual([]);
  fireEvent.click(rows[1]);
  expect(rows[1].getAttribute("aria-checked")).toBe("true");
  expect(rows[0].getAttribute("aria-checked")).toBe("false");
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post")).at(-1)).toBe(PAGE.post_urn));
  await screen.findByText("The post text");
  const fromPick = await createCampaign(picked.onApprove);
  expect(fromPick.post).toBe(PAGE.post_urn);
  cleanup();

  api.mockClear();
  const pasted = await open();
  expect(screen.queryByRole("radiogroup")).toBeNull();
  fireEvent.change(pasteField(), { target: { value: PAGE.post_urn } });
  expect(pasteField().value).toBe(PAGE.post_urn);
  const fromPaste = await createCampaign(pasted.onApprove);
  expect(fromPaste).toEqual(fromPick);
  expect(calls("/posts?")).toEqual([]);
});

it("preselects the newest listed post so the preview shows it and Create is ready without a click", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  const { onApprove } = await open();
  const rows = within(await chooseList()).getAllByRole("radio");
  expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(screen.queryByRole("textbox", { name: "The post to promote" })).toBeNull();
  const preview = screen.getByRole("complementary", { name: "Preview" });
  expect(await within(preview).findByText("The post text")).toBeTruthy();
  expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe(USED.thumbnail_url);
  expect(within(preview).queryByText(/Paste the link to a company post/)).toBeNull();
  expect(screen.queryByTestId("suggested-post-text")).toBeNull();
  expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([USED.post_urn]);
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(USED.post_urn);
});

it("does not count the preselected post as the founder's own change when they cancel", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  const onClose = vi.fn();
  render(<SponsoredPostReview action={{ id: `action-${++seq}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem} spec={spec} handlers={{ onApprove: vi.fn(), onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={onClose} />);
  await choosePosts();
  await waitFor(() => expect(screen.getByRole("radio").getAttribute("aria-checked")).toBe("true"));
  await screen.findByText("The post text");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Discard your changes?")).toBeNull();
});

it("says at the top of the form when this workspace cannot approve campaigns", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  render(<SponsoredPostReview action={{ id: `action-${++seq}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem} spec={spec} handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn() } as never} onPrepared={vi.fn()} onClose={vi.fn()} />);
  const note = await screen.findByTestId("create-unavailable");
  expect(note.textContent).toBe("You cannot approve campaigns in this workspace.");
  expect(note.closest("footer")).toBeNull();
  expect(create().disabled).toBe(true);
});

it("names a row with no text by what it is, and shows an image-only post as header and image without the unreadable sentence", async () => {
  const IMAGE_ONLY = { post_urn: "urn:li:ugcPost:7390000000000000001", text: null, date: null, thumbnail_url: "https://media.licdn.com/dms/image/only/0", label: "Page post" };
  posts = () => Promise.resolve({ posts: [IMAGE_ONLY, PAGE, USED], page_name: "Zavi Labs" });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.includes("/post-preview?") ? Promise.resolve({ post_urn: new URL(path, "http://x").searchParams.get("post"), author: "page", post_preview: null }) : read(path));
  await open();
  const [imageRow, bareRow, textRow] = within(await chooseList()).getAllByRole("radio");
  expect(document.body.textContent).not.toContain("No text to show for this post");
  const line = (row: HTMLElement) => row.children[1].lastElementChild as HTMLElement;
  expect(line(imageRow).textContent).toBe("Image post");
  expect(line(bareRow).textContent).toBe("Post without text");
  expect(line(textRow).textContent).toBe(USED.text);
  expect(classes(line(imageRow))).toContain("text-inkMuted");
  expect(classes(line(bareRow))).toContain("text-inkMuted");
  expect(classes(line(textRow))).toContain("text-ink");
  expect(classes(line(textRow))).not.toContain("text-inkMuted");
  const preview = screen.getByRole("complementary", { name: "Preview" });
  const card = within(preview).getByRole("article", { name: "LinkedIn post preview" });
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.load(within(card).getByTestId("post-preview-image"));
  await waitFor(() => expect(within(preview).queryByTestId("post-preview-skeleton")).toBeNull());
  expect(within(card).getByTestId("post-preview-image").getAttribute("src")).toBe(IMAGE_ONLY.thumbnail_url);
  expect(preview.textContent).not.toContain("LinkedIn did not share this post's text");
  expect([...card.children].map((c) => c.tagName)).toEqual(["HEADER", "IMG", "FOOTER"]);
  fireEvent.error(within(card).getByTestId("post-preview-image"));
  expect(preview.textContent).toContain("LinkedIn did not share this post's text");
  expect(line(imageRow).textContent).toBe("Post without text");
  fireEvent.click(bareRow);
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  expect(preview.textContent).toContain("LinkedIn did not share this post's text");
});

it("drops the picked post from the campaign and the preview while the paste view is open, and brings it back with the list", async () => {
  posts = () => Promise.resolve({ posts: [{ ...USED, thumbnail_url: "https://media.licdn.com/dms/image/used.jpg" }, PAGE], page_name: "Zavi Labs" });
  const { onApprove } = await open();
  await chooseList();
  const preview = screen.getByRole("complementary", { name: "Preview" });
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe("https://media.licdn.com/dms/image/used.jpg");
  fireEvent.click(swap("Paste a link"));
  expect(pasteField().value).toBe("");
  expect(pasteField().required).toBe(true);
  expect(create().disabled).toBe(true);
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  expect(preview.textContent).not.toContain(USED.text);
  expect(preview.textContent).not.toContain("LinkedIn will promote this post");
  fireEvent.submit(create().closest("form") ?? document.querySelector("form")!);
  await new Promise((r) => setTimeout(r, 30));
  expect(prepareBodies()).toHaveLength(0);
  expect(pasteField().value).toBe("");
  fireEvent.click(swap("Choose from posts"));
  expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe("https://media.licdn.com/dms/image/used.jpg");
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(USED.post_urn);
});

it("does not preselect over a link pasted while the list was still loading", async () => {
  let release!: (v: unknown) => void;
  posts = () => new Promise((r) => { release = r; });
  const { onApprove } = await open();
  await choosePosts();
  await screen.findByTestId("post-picker-loading");
  expect(screen.queryByRole("textbox", { name: /^The post to promote/ })).toBeNull();
  fireEvent.click(swap("Paste a link"));
  expect(screen.queryByTestId("post-picker-loading")).toBeNull();
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  await act(async () => { release({ posts: [USED, PAGE], page_name: "Zavi Labs" }); });
  await settle(550);
  expect(swap("Choose from posts")).toBeTruthy();
  expect(pasteField().value).toBe(PASTED);
  expect(screen.queryByRole("radiogroup")).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([PASTED]);
  fireEvent.click(swap("Choose from posts"));
  expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  fireEvent.click(swap("Paste a link"));
  expect(pasteField().value).toBe(PASTED);
  expect(calls("/posts?")).toHaveLength(1);
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(PASTED);
});

it("names the preview after the page from the post list when LinkedIn returns no page name", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.includes("/post-preview?") ? Promise.resolve({ post_urn: USED.post_urn, post_preview: "The post text" }) : read(path));
  await open();
  await choosePosts();
  const card = within(screen.getByRole("complementary", { name: "Preview" })).getByRole("article", { name: "LinkedIn post preview" });
  await within(card).findByText("The post text");
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.load(within(card).getByTestId("post-preview-image"));
  const title = card.querySelector("header .truncate")!;
  expect(title.textContent).toBe("Zavi Labs");
  expect(within(card).queryByText("LinkedIn post")).toBeNull();
  cleanup();

  api.mockImplementation((path: string) => path.includes("/post-preview?") ? Promise.resolve({ post_urn: USED.post_urn, author: "page", page: { name: null, logo_url: null }, post_preview: "The post text" }) : read(path));
  await open();
  await choosePosts();
  const again = within(screen.getByRole("complementary", { name: "Preview" })).getByRole("article", { name: "LinkedIn post preview" });
  await within(again).findByText("The post text");
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.load(within(again).getByTestId("post-preview-image"));
  expect(again.querySelector("header .truncate")!.textContent).toBe("Zavi Labs");
});

it("says beside the field what Create is waiting for, never in the footer", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  await open();
  await chooseList();
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(screen.queryByTestId("audience-needed")).toBeNull();
  const box = screen.getByRole("checkbox", { name: /no professional audience/ });
  fireEvent.click(box);
  expect(create().disabled).toBe(true);
  const needed = screen.getByTestId("audience-needed");
  expect(needed.className).toContain("text-danger");
  expect(needed.textContent).toBe("Choose a job title, seniority, industry or company size, or tick the box above.");
  expect(needed.closest("footer")).toBeNull();
  expect(needed.closest("section")).toBe(box.closest("section"));
  expect(box.compareDocumentPosition(needed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(box);
  expect(screen.queryByTestId("audience-needed")).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  const budget = screen.getByLabelText("Spend up to, per day (USD)");
  expect(screen.queryByTestId("budget-needed")).toBeNull();
  fireEvent.change(budget, { target: { value: "" } });
  expect(create().disabled).toBe(true);
  expect(budget.closest("label")!.contains(screen.getByTestId("budget-needed"))).toBe(true);
  expect(screen.getByTestId("budget-needed").textContent).toBe("Enter a daily budget.");
});

it("says no posts were found for the page and still takes a pasted link through to create", async () => {
  const { onApprove } = await open();
  expect(screen.queryByTestId("post-picker-empty")).toBeNull();
  await choosePosts();
  const empty = await screen.findByTestId("post-picker-empty");
  expect(empty.textContent).toBe("No posts to pick from yet for Zavi Labs. Zavi can only list posts already used in an ad on this account, so paste the link of the post you want to promote.");
  expect(screen.queryByRole("radiogroup")).toBeNull();
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(PASTED);
});

it("keeps paste and create working when the post list fails, and reads it again on request", async () => {
  posts = () => Promise.reject(Object.assign(new Error("LinkedIn Ads is not responding right now."), { status: 502, code: "linkedin_ads_http_error" }));
  const { onApprove } = await open();
  await choosePosts();
  await screen.findByTestId("post-picker-failed");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(pasteField().required).toBe(true);
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  fireEvent.click(screen.getByRole("button", { name: "try again" }));
  await screen.findByRole("radiogroup", { name: "Choose a post to promote" });
  expect(calls("/posts?")).toHaveLength(2);
  cleanup();

  posts = () => Promise.reject(new Error("down"));
  const again = await open();
  await choosePosts();
  await screen.findByTestId("post-picker-failed");
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  const body = await createCampaign(again.onApprove);
  expect(body.post).toBe(PASTED);
  expect(onApprove).not.toHaveBeenCalled();
});

it("keeps paste and create working while the post list is still loading", async () => {
  posts = () => new Promise(() => undefined);
  const { onApprove } = await open();
  await choosePosts();
  expect(screen.getByTestId("post-picker-loading")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /^The post to promote/ })).toBeNull();
  expect(create().disabled).toBe(true);
  fireEvent.click(swap("Paste a link"));
  expect(screen.queryByTestId("post-picker-loading")).toBeNull();
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(PASTED);
  expect(calls("/posts?")).toHaveLength(1);
});

const swap = (name: string) => screen.getByRole("button", { name });
const classes = (el: Element) => el.className.split(/\s+/);

it("swaps the post list for the paste field with one button, one view at a time, and keeps each value", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  const { onApprove } = await open();
  const list = () => screen.queryByRole("radiogroup", { name: "Choose a post to promote" });
  const field = () => screen.queryByRole("textbox", { name: "The post to promote" }) as HTMLInputElement | null;
  expect(list()).toBeNull();
  expect(field()!.value).toBe("");
  expect(screen.getAllByTestId("post-view-swap")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Paste a link" })).toBeNull();
  await chooseList();
  expect(field()).toBeNull();
  expect(screen.queryByTestId("paste-instead")).toBeNull();
  expect(screen.getAllByTestId("post-view-swap")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Choose from posts" })).toBeNull();
  const toPaste = swap("Paste a link");
  expect(toPaste.tagName).toBe("BUTTON");
  expect(toPaste.getAttribute("type")).toBe("button");
  expect(classes(toPaste)).toEqual(expect.arrayContaining(["inline-flex", "h-8", "rounded-lg", "border", "border-rule"]));
  expect(classes(toPaste)).not.toContain("underline");
  expect(toPaste.querySelector("svg")).not.toBeNull();
  expect(toPaste.parentElement!.querySelector("h3")!.textContent).toBe("Post");
  expect(classes(toPaste.parentElement!)).toContain("justify-between");

  fireEvent.click(within(list()!).getAllByRole("radio")[0]);
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([USED.post_urn]));
  fireEvent.click(toPaste);
  expect(list()).toBeNull();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Paste a link" })).toBeNull();
  expect(field()!.value).toBe("");
  expect(field()!.required).toBe(true);
  expect(create().disabled).toBe(true);

  fireEvent.click(swap("Choose from posts"));
  expect(field()).toBeNull();
  expect(within(list()!).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);

  fireEvent.click(swap("Paste a link"));
  fireEvent.change(field()!, { target: { value: PASTED } });
  expect(field()!.value).toBe(PASTED);
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([USED.post_urn, PASTED]));
  fireEvent.click(swap("Choose from posts"));
  expect(within(list()!).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  fireEvent.click(swap("Paste a link"));
  expect(field()!.value).toBe(PASTED);
  expect(field()!.required).toBe(true);

  fireEvent.click(swap("Choose from posts"));
  fireEvent.click(within(list()!).getAllByRole("radio")[1]);
  expect(within(list()!).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  fireEvent.click(swap("Paste a link"));
  expect(field()!.value).toBe(PASTED);
  fireEvent.click(swap("Choose from posts"));
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(PAGE.post_urn);
  expect(prepareBodies()).toHaveLength(1);
});

it("draws the picked row's post in the live preview with its image, as a skeleton while LinkedIn is read", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  let release!: (v: unknown) => void;
  const held = new Promise((r) => { release = r; });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.includes("/post-preview?") ? held : read(path));
  await open();
  const rows = within(await chooseList()).getAllByRole("radio");
  const preview = screen.getByRole("complementary", { name: "Preview" });
  const skeleton = within(preview).getByTestId("post-preview-skeleton");
  expect(skeleton.getAttribute("aria-busy")).toBe("true");
  expect(skeleton.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(3);
  expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe(USED.thumbnail_url);
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([USED.post_urn]));
  expect(create().disabled).toBe(true);
  release({ post_urn: USED.post_urn, author: "page", page: { name: "Zavi Labs", logo_url: null }, post_preview: "Text LinkedIn returned for the picked post" });
  expect(await within(preview).findByText("Text LinkedIn returned for the picked post")).toBeTruthy();
  await waitFor(() => expect(create().disabled).toBe(false));
  const card = within(preview).getByRole("article", { name: "LinkedIn post preview" });
  expect(within(preview).getByTestId("post-preview-skeleton")).toBeTruthy();
  expect(within(preview).getByTestId("post-preview-image-skeleton")).toBeTruthy();
  expect(classes(within(card).getByTestId("post-preview-image"))).toContain("hidden");
  expect(card.querySelector("header .truncate")).toBeNull();
  expect(preview.textContent).not.toContain("LinkedIn will promote this post");
  fireEvent.load(within(card).getByTestId("post-preview-image"));
  expect(within(preview).queryByTestId("post-preview-skeleton")).toBeNull();
  expect(within(preview).queryByTestId("post-preview-image-skeleton")).toBeNull();
  expect(classes(within(card).getByTestId("post-preview-image"))).not.toContain("hidden");
  expect(card.querySelector("header .truncate")!.textContent).toBe("Zavi Labs");
  expect(within(card).getByTestId("post-preview-image").getAttribute("src")).toBe(USED.thumbnail_url);
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(rows[1]);
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  fireEvent.click(rows[0]);
  fireEvent.error(within(preview).getByTestId("post-preview-image"));
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
});

it("keeps a thumbnail slot on every row, with an icon tile when the post has no image, and marks the selected row", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  await open();
  const [withThumb, without] = within(await chooseList()).getAllByRole("radio");
  const image = withThumb.firstElementChild as HTMLImageElement;
  expect(image.tagName).toBe("IMG");
  expect(image.getAttribute("src")).toBe(USED.thumbnail_url);
  expect(within(withThumb).queryByTestId("post-thumb-placeholder")).toBeNull();
  const tile = without.firstElementChild as HTMLElement;
  expect(tile.getAttribute("data-testid")).toBe("post-thumb-placeholder");
  expect(tile.getAttribute("aria-hidden")).toBe("true");
  expect(tile.querySelector("svg")).not.toBeNull();
  expect(classes(tile)).toEqual(expect.arrayContaining(["bg-bone", "border", "border-rule", "text-inkMuted"]));
  for (const slot of [image, tile]) expect(classes(slot)).toEqual(expect.arrayContaining(["size-24", "shrink-0", "rounded-xl"]));
  expect(classes(image)).toContain("object-cover");
  expect(classes(withThumb.parentElement!)).toEqual(expect.arrayContaining(["max-h-[420px]", "overflow-y-auto", "gap-3"]));
  expect(classes(withThumb)).toEqual(expect.arrayContaining(["border-ink", "ring-1", "ring-ink"]));
  expect(classes(within(without).getByText("Post without text"))).toContain("line-clamp-2");
  expect(classes(within(withThumb).getByText(USED.text))).toContain("line-clamp-3");
  expect(classes(within(withThumb).getByText(USED.text))).not.toContain("line-clamp-2");
  expect(classes(withThumb)).toContain("bg-ink/5");
  expect(classes(without)).not.toContain("bg-ink/5");
  for (const row of [withThumb, without]) expect(classes(row)).toContain("focus-visible:ring-2");
  for (const row of [withThumb, without]) {
    expect(classes(row)).toEqual(expect.arrayContaining(["flex", "w-full", "shrink-0", "cursor-pointer", "items-center", "gap-4", "p-4", "rounded-2xl", "border"]));
    expect(row.children).toHaveLength(3);
  }
  fireEvent.error(image);
  expect(withThumb.querySelector("img")).toBeNull();
  expect(within(withThumb).getByTestId("post-thumb-placeholder")).toBeTruthy();
  fireEvent.click(without);
  expect(classes(without)).toEqual(expect.arrayContaining(["border-ink", "bg-ink/5", "ring-1", "ring-ink"]));
  expect(classes(within(without).getByText("Post without text"))).toContain("line-clamp-3");
  expect(classes(within(withThumb).getByText(USED.text))).toContain("line-clamp-2");
  expect(classes(withThumb)).not.toContain("ring-ink");
  expect(classes(without.lastElementChild!)).toEqual(expect.arrayContaining(["bg-ink", "text-cream", "border-ink"]));
  expect(without.lastElementChild!.querySelector("svg")).not.toBeNull();
  expect(classes(withThumb.lastElementChild!)).not.toContain("bg-ink");
  expect(withThumb.lastElementChild!.querySelector("svg")).toBeNull();
  expect(classes(withThumb)).toEqual(expect.arrayContaining(["hover:border-inkMuted", "hover:bg-creamDeep"]));
});

it("shows no text beside Cancel and Create, and no helper line under the list", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  await open();
  await chooseList();
  const footer = create().closest("footer")!;
  const visible = () => [...footer.querySelectorAll("*")].filter((el) => !el.closest(".sr-only") && el.children.length === 0).map((el) => el.textContent);
  expect(create().disabled).toBe(true);
  expect(visible()).toEqual(["Cancel", "Create paused campaign"]);
  expect(screen.queryByTestId("post-needed")).toBeNull();
  expect(screen.getByTestId("create-blocked-reason").className).toBe("sr-only");
  expect(document.body.textContent).not.toContain("Paste the LinkedIn post to promote.");
  expect(screen.queryByTestId("post-picker-ads-only")).toBeNull();
  expect(document.body.textContent).not.toContain("Only posts already used in an ad are listed here");
  expect([...screen.getByTestId("post-picker").children].map((c) => c.getAttribute("role"))).toEqual(["radiogroup"]);
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(screen.queryByTestId("create-blocked-reason")).toBeNull();
  expect(visible()).toEqual(["Cancel", "Create paused campaign"]);
});

it("opens on the paste field with the swap button, and after choosing the list and getting none, shows the empty note and keeps the paste field", async () => {
  await open();
  expect(pasteField().required).toBe(true);
  expect(screen.getAllByTestId("post-view-swap").map((b) => b.textContent)).toEqual(["Choose from posts"]);
  expect(screen.queryByTestId("post-picker")).toBeNull();
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Paste the link of the post to promote.");
  expect(calls("/posts?")).toEqual([]);
  await choosePosts();
  const empty = await screen.findByTestId("post-picker-empty");
  expect(calls("/posts?")).toHaveLength(1);
  expect(screen.getAllByTestId("post-view-swap").map((b) => b.textContent)).toEqual(["Paste a link"]);
  expect(screen.queryByTestId("post-picker-loading")).toBeNull();
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(document.body.textContent!.split("already used in an ad").length - 1).toBe(1);
  expect(empty.compareDocumentPosition(pasteField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pasteField().required).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Paste the link of the post to promote.");
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  await waitFor(() => expect(create().disabled).toBe(false));
});

it("opens on the paste field, with the way back to the list, when the draft's post is not one of the rows", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.endsWith("/review") ? read(path).then((r: { draft: object }) => ({ ...r, draft: { ...r.draft, post_urn: PAGE.post_urn } })) : read(path));
  await open();
  expect((await screen.findByRole("textbox", { name: "The post to promote" }) as HTMLInputElement).value).toBe(PAGE.post_urn);
  await screen.findByRole("button", { name: "Choose from posts" });
  expect(screen.queryByRole("radiogroup")).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(calls("/posts?")).toEqual([]);
  expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([PAGE.post_urn]);
  fireEvent.click(swap("Choose from posts"));
  await waitFor(() => expect(screen.getByRole("radio").getAttribute("aria-checked")).toBe("true"));
  expect(calls("/posts?")).toHaveLength(1);
  fireEvent.click(swap("Paste a link"));
  expect(pasteField().value).toBe(PAGE.post_urn);
  await waitFor(() => expect(create().disabled).toBe(false));
});

it("shows LinkedIn's author note as a warning notice block, not loose red text", async () => {
  posts = () => Promise.resolve({ posts: [USED], page_name: "Zavi Labs" });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.includes("/post-preview?") ? Promise.resolve({ post_urn: USED.post_urn, author: "unknown", author_note: "LinkedIn could not confirm who wrote this post.", post_preview: "The post text" }) : read(path));
  await open();
  await choosePosts();
  const note = await screen.findByTestId("post-author-note");
  expect(note.getAttribute("role")).toBe("status");
  expect(note.textContent).toBe("LinkedIn could not confirm who wrote this post.");
  expect(classes(note)).toEqual(expect.arrayContaining(["flex", "rounded-xl", "border", "bg-warnBg", "p-3"]));
  expect(classes(note)).not.toContain("text-danger");
  expect(note.querySelector("svg")!.getAttribute("class")).toContain("text-warn");
  expect(note.closest("section")).toBe(screen.getByRole("radiogroup").closest("section"));
  await waitFor(() => expect(create().disabled).toBe(false));
});

it("shows the image LinkedIn returns for a pasted post in the live preview, and none when there is none", async () => {
  const IMAGE = "https://media.licdn.com/dms/image/pasted/0";
  let answer: Record<string, unknown> = { image_url: IMAGE };
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.includes("/post-preview?") ? Promise.resolve({ post_urn: "urn:li:share:7300000000000000002", author: "page", post_preview: "Pasted post text", ...answer }) : read(path));
  await open();
  const preview = screen.getByRole("complementary", { name: "Preview" });
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  await within(preview).findByText("Pasted post text");
  const image = within(within(preview).getByRole("article", { name: "LinkedIn post preview" })).getByTestId("post-preview-image");
  expect(image.getAttribute("src")).toBe(IMAGE);
  fireEvent.error(image);
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  expect(within(preview).getByText("Pasted post text")).toBeTruthy();
  cleanup();

  for (const none of [{}, { image_url: null }, { image_url: "http://media.licdn.com/insecure" }, { image_url: "javascript:alert(1)" }]) {
    answer = none;
    await open();
    fireEvent.change(pasteField(), { target: { value: PASTED } });
    await within(screen.getByRole("complementary", { name: "Preview" })).findByText("Pasted post text");
    expect(screen.queryByTestId("post-preview-image")).toBeNull();
    cleanup();
  }
  expect(calls("/posts?")).toEqual([]);
});

it("prefers the picked row's thumbnail over the preview answer's image, and falls back to it when the thumbnail breaks", async () => {
  const IMAGE = "https://media.licdn.com/dms/image/full/0";
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.includes("/post-preview?") ? Promise.resolve({ post_urn: new URL(path, "http://x").searchParams.get("post"), author: "page", post_preview: "The post text", image_url: IMAGE }) : read(path));
  await open();
  const rows = within(await chooseList()).getAllByRole("radio");
  const preview = screen.getByRole("complementary", { name: "Preview" });
  await within(preview).findByText("The post text");
  expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe(USED.thumbnail_url);
  fireEvent.error(within(preview).getByTestId("post-preview-image"));
  expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe(IMAGE);
  expect(rows[0].querySelector("img")).toBeNull();
  fireEvent.click(rows[1]);
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  await waitFor(() => expect(within(preview).getByTestId("post-preview-image").getAttribute("src")).toBe(IMAGE));
});

it("never asks for a post list on the shared wallet account", async () => {
  accounts = [WALLET];
  inUse = WALLET.account_binding_id;
  await open();
  expect(screen.getByTestId("account-billing").textContent).toContain("runs on the Zavi account");
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("account_id"))).toEqual([WALLET.id]));
  expect(calls("/posts?")).toEqual([]);
  expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([PASTED]);
  expect(screen.queryByTestId("post-picker")).toBeNull();
  expect(screen.queryByTestId("post-picker-loading")).toBeNull();
  expect(screen.queryByTestId("post-view-swap")).toBeNull();
  expect(screen.queryByRole("button", { name: /Paste a link|Choose from posts/ })).toBeNull();
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(screen.getAllByRole("textbox", { name: /post/i })).toEqual([screen.getByRole("textbox", { name: "The post to promote" })]);
  expect(pasteField().value).toBe(PASTED);
});

it("asks LinkedIn for the page's posts only after the founder chooses the list, and only once however often the view is swapped", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  const pasted = await open();
  await settle(50);
  expect(calls("/posts?")).toEqual([]);
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  const fromPaste = await createCampaign(pasted.onApprove);
  expect(fromPaste.post).toBe(PASTED);
  await settle(50);
  expect(calls("/posts?")).toEqual([]);
  expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([PASTED]);
  expect(screen.queryByTestId("post-picker")).toBeNull();
  cleanup();

  api.mockClear();
  const { action, onApprove } = await open();
  await settle(50);
  expect(calls("/posts?")).toEqual([]);
  await chooseList();
  expect(calls("/posts?")).toEqual([`/api/channels/linkedin_ads/actions/${action.id}/posts?account_id=11`]);
  fireEvent.click(swap("Paste a link"));
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  fireEvent.click(swap("Choose from posts"));
  expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  fireEvent.click(swap("Paste a link"));
  expect(pasteField().value).toBe(PASTED);
  fireEvent.click(swap("Choose from posts"));
  expect(screen.queryByTestId("post-picker-loading")).toBeNull();
  expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  await settle(50);
  expect(calls("/posts?")).toHaveLength(1);
  const fromPick = await createCampaign(onApprove);
  expect(fromPick.post).toBe(USED.post_urn);
  expect(calls("/posts?")).toHaveLength(1);
});

it("does not put the newest post into the campaign or the preview when the list answers after the founder went back to paste", async () => {
  let release!: (v: unknown) => void;
  posts = () => new Promise((r) => { release = r; });
  const { onApprove } = await open();
  await choosePosts();
  await screen.findByTestId("post-picker-loading");
  fireEvent.click(swap("Paste a link"));
  await act(async () => { release({ posts: [USED, PAGE], page_name: "Zavi Labs" }); });
  await settle(800);
  const preview = screen.getByRole("complementary", { name: "Preview" });
  expect(calls("/post-preview?")).toEqual([]);
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Paste the link of the post to promote.");
  expect(within(preview).queryByTestId("post-preview-image")).toBeNull();
  expect(within(preview).queryByText("The post text")).toBeNull();
  expect(pasteField().value).toBe("");
  expect(pasteField().required).toBe(true);
  expect(screen.queryByRole("radiogroup")).toBeNull();
  fireEvent.submit(document.querySelector("form")!);
  await settle(30);
  expect(prepareBodies()).toEqual([]);
  expect(onApprove).not.toHaveBeenCalled();
  fireEvent.click(swap("Choose from posts"));
  expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).toEqual([USED.post_urn]));
  const body = await createCampaign(onApprove);
  expect(body.post).toBe(USED.post_urn);
  expect(calls("/posts?")).toHaveLength(1);
});

it("keeps a link pasted before choosing the list in the paste field when the list comes back empty, and keeps a link typed there when going back", async () => {
  await open();
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  await choosePosts();
  await screen.findByTestId("post-picker-empty");
  await waitFor(() => expect(pasteField().value).toBe(PASTED));
  await waitFor(() => expect(create().disabled).toBe(false));
  const typedThere = "https://www.linkedin.com/posts/zavi-labs_launch-share-7300000000000000003-AbCd";
  fireEvent.change(pasteField(), { target: { value: typedThere } });
  fireEvent.click(swap("Paste a link"));
  expect(pasteField().value).toBe(typedThere);
  await waitFor(() => expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post")).at(-1)).toBe(typedThere));
  await waitFor(() => expect(create().disabled).toBe(false));
});

it("picks the draft's own post when it is one of the rows, not the newest row", async () => {
  posts = () => Promise.resolve({ posts: [USED, PAGE], page_name: "Zavi Labs" });
  const read = api.getMockImplementation()!;
  api.mockImplementation((path: string) => path.endsWith("/review") ? read(path).then((r: { draft: object }) => ({ ...r, draft: { ...r.draft, post_urn: PAGE.post_urn } })) : read(path));
  await open();
  expect((await screen.findByRole("textbox", { name: "The post to promote" }) as HTMLInputElement).value).toBe(PAGE.post_urn);
  await choosePosts();
  const group = await screen.findByRole("radiogroup", { name: "Choose a post to promote" });
  await waitFor(() => expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]));
  await settle(50);
  expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  expect(calls("/post-preview?").map((p) => new URL(p, "http://x").searchParams.get("post"))).not.toContain(USED.post_urn);
});

it("reads the list again after a failure and lists it, keeping a link typed in between for the paste view", async () => {
  let fail = true;
  posts = () => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ posts: [USED], page_name: "Zavi Labs" }));
  await open();
  await choosePosts();
  await screen.findByTestId("post-picker-failed");
  fireEvent.change(pasteField(), { target: { value: PASTED } });
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "try again" }));
  const group = await screen.findByRole("radiogroup", { name: "Choose a post to promote" });
  await waitFor(() => expect(within(group).getByRole("radio").getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(swap("Paste a link"));
  expect(pasteField().value).toBe(PASTED);
});
