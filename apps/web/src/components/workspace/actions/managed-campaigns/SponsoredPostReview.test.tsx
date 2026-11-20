// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { forgetLinkedInAudienceOptions } from "./LinkedInAudiencePicker";
import type { ActionItem } from "../types";
import { closeCampaignReview, openCampaignReview } from "./openCampaignReview";
import { ADS_CONNECTION_CHANGED_EVENT, cachedCampaignReview, holdCampaignReview, invalidateCampaignReviews } from "./campaignReviewPrefetch";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
const floor = vi.hoisted(() => ({ usd: 0 }));
vi.mock("@zavi/shared", async (actual) => {
  const real = await actual<typeof import("@zavi/shared")>();
  return { ...real, adConstraint: (slug: string) => {
    const row = real.adConstraint(slug);
    return row && slug === "linkedin_ads" && floor.usd ? { ...row, min_daily_usd: floor.usd } : row;
  } };
});
const action = { id: "action-1", body: {}, channel_slug: "linkedin_ads" } as ActionItem;
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const review = () => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Company post", post_urn: "urn:li:share:7123456789012345678", country: "US", audience_suggestions: { titles: ["Chief Executive Officer"], seniorities: [], industries: [], staffCountRanges: [] } },
  accounts: [{ id: "11", name: "Account one", currency: "USD", funding_source: "provider" }, { id: "22", name: "Account two", currency: "USD", funding_source: "provider" }],
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
});
beforeEach(() => {
  forgetLinkedInAudienceOptions();
  floor.usd = 0;
  api.mockReset();
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review() : path.includes("/targeting?")
    ? { options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] }
    : path.includes("/locations?") ? { locations: [{ id: "urn:li:geo:102095887", name: "California, United States" }, { id: "urn:li:geo:101174742", name: "Canada" }] }
    : { exact_change: { rows: [] } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
const nativeScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => { cleanup(); Element.prototype.scrollIntoView = nativeScrollIntoView; });
const create = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
function open() {
  const onApprove = vi.fn().mockResolvedValue(true);
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
  return onApprove;
}
const postChecked = async () => {
  await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).includes("/post-preview?"))).toBe(true));
  await act(async () => { await Promise.resolve(); });
};
const createReady = () => waitFor(() => expect(create().disabled).toBe(false));
const ready = async () => { const pill = await screen.findByRole("button", { name: "Chief Executive Officer" }); await postChecked(); return pill; };
const REMOVE_CEO = { name: "Remove Chief Executive Officer" };
const BROAD = { name: /location and language only|Show this to everyone/ };
const prefilled = () => screen.findByRole("button", REMOVE_CEO);
async function audienceSettled() {
  await waitFor(() => { if (!screen.queryByRole("button", REMOVE_CEO) && !screen.queryByRole("checkbox", BROAD)) throw new Error("no audience yet"); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function selectTitle() {
  await audienceSettled();
  if (screen.queryByRole("button", REMOVE_CEO)) return;
  fireEvent.change(await screen.findByRole("combobox", { name: "Job titles" }), { target: { value: "Chief" } });
  fireEvent.click(await screen.findByRole("option", { name: "Chief Executive Officer" }));
}
async function clearAudience() {
  await audienceSettled();
  const chip = screen.queryByRole("button", REMOVE_CEO);
  if (chip) fireEvent.click(chip);
}
async function broadOnly() {
  await clearAudience();
  fireEvent.click(await screen.findByRole("checkbox", BROAD));
}
const reviewReads = () => api.mock.calls.filter(([p]) => String(p).endsWith("/review")).length;
async function connectionChange(next: Record<string, unknown>) {
  const reads = reviewReads();
  const fallback = api.getMockImplementation()!;
  api.mockImplementation((path: string, init?: unknown) => path.endsWith("/review") ? Promise.resolve(next) : fallback(path, init));
  await act(async () => { window.dispatchEvent(new Event(ADS_CONNECTION_CHANGED_EVENT)); });
  await waitFor(() => expect(reviewReads()).toBe(reads + 1));
  await screen.findByText("Pilot");
}
const bodyOf = () => JSON.parse(api.mock.calls.find(([p]) => String(p).endsWith("/prepare"))![1].body);
it("carries a reviewed LinkedIn match through preparation and approval", async () => {
  const approve = open();
  await ready();
  await prefilled();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  const prepared = api.mock.calls.find(([path]) => path.endsWith("/prepare"));
  expect(JSON.parse(prepared![1].body)).toMatchObject({ account_id: "11", audience: { titles: ["urn:li:title:1"], seniorities: [] }, use_broad_audience: false });
});
it("shows no post how-to and no Not restricted line on untouched audience fields", async () => {
  open(); await ready();
  const post = screen.getByLabelText("The post to promote");
  expect(post.closest("label")!.textContent).toBe("The post to promote");
  expect(post.getAttribute("aria-describedby")).toBeNull();
  expect(screen.queryByText(/Not restricted/)).toBeNull();
  fireEvent.change(post, { target: { value: "not a link" } });
  expect(document.getElementById(post.getAttribute("aria-describedby")!)!.textContent).toContain("does not recognise this as a LinkedIn post link");
});
it("suggests job titles as the founder types, with no search button, and asks LinkedIn once for a burst of keys", async () => {
  open(); await ready();
  fireEvent.click(await prefilled());
  const field = screen.getByRole("combobox", { name: "Job titles" });
  expect(screen.queryByText(/^Search job titles|^Search industries/)).toBeNull();
  expect(screen.queryByRole("button", { name: /^(Search|Show )/i })).toBeNull();
  const searches = () => api.mock.calls.filter(([p]) => String(p).includes("facet=titles")).map(([p]) => new URLSearchParams(String(p).split("?")[1]).get("query"));
  fireEvent.change(field, { target: { value: "Ch" } });
  fireEvent.change(field, { target: { value: "Chi" } });
  fireEvent.change(field, { target: { value: "Chief" } });
  const option = await screen.findByRole("option", { name: "Chief Executive Officer" });
  expect(searches()).toEqual(["Chief Executive Officer", "Chief"]);
  expect(field.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(field, { key: "ArrowDown" });
  expect(field.getAttribute("aria-activedescendant")).toBe(option.id);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(option.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "Remove Chief Executive Officer" })).toBeTruthy();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.queryByRole("button", { name: "Remove Chief Executive Officer" })).toBeNull();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  fireEvent.change(field, { target: { value: "C" } });
  await new Promise((r) => setTimeout(r, 400));
  expect(searches()).toEqual(["Chief Executive Officer", "Chief"]);
});
it("requires explicit agreement before replacing suggested targeting with a broad audience", async () => {
  open(); await ready();
  await prefilled();
  expect(screen.queryByRole("checkbox", BROAD)).toBeNull();
  await clearAudience();
  expect(create().disabled).toBe(true);
  await broadOnly();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(true));
  expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body)).toMatchObject({ use_broad_audience: true, audience: { titles: [], seniorities: [], industries: [], staffCountRanges: [] } });
});
it("prevents LinkedIn's incompatible title and seniority combination", async () => {
  open(); await selectTitle();
  const seniority = (await screen.findByRole("group", { name: "Seniority options" })).closest("fieldset")!;
  expect(seniority.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove Chief Executive Officer" }));
  expect(seniority.disabled).toBe(false);
  const pill = within(seniority).getByRole("button", { name: "Chief Executive Officer" });
  fireEvent.click(pill);
  expect(pill.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("combobox", { name: "Job titles" }).closest("fieldset")!.disabled).toBe(true);
  fireEvent.click(pill);
  expect(pill.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("combobox", { name: "Job titles" }).closest("fieldset")!.disabled).toBe(false);
});
it("an open review re-reads the ad accounts when the LinkedIn connection changes, drops the old login's account and creates on the new one", async () => {
  const approve = open(); await ready();
  await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).includes("/targeting?") && String(p).includes("account_id=11"))).toBe(true));
  await connectionChange({ ...review(), accounts: [{ id: "33", name: "New login account", currency: "USD", funding_source: "provider" }, { id: "44", name: "Second new account", currency: "USD", funding_source: "provider" }] });
  await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).includes("/targeting?") && String(p).includes("account_id=33"))).toBe(true));
  await selectTitle();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(bodyOf()).toMatchObject({ account_id: "33", audience: { titles: ["urn:li:title:1"] } });
  expect(api.mock.calls.some(([p]) => String(p).includes("/targeting?") && String(p).includes("account_id=44"))).toBe(false);
});
it("says beside a disabled Create what is still missing, and drops the reason once it is fixed", async () => {
  open(); await ready();
  await clearAudience();
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Choose at least one job title, seniority, industry or company size, or tick the box to use location and language only.");
  await selectTitle();
  await createReady();
  expect(screen.queryByTestId("create-blocked-reason")).toBeNull();
  fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "" } });
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Enter a daily budget.");
});
it("shows lookup failures without applying a guessed audience or enabling creation", async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review();
    throw new Error("LinkedIn is unavailable");
  });
  open(); fireEvent.click(await ready());
  expect((await screen.findAllByText("LinkedIn is unavailable")).length).toBeGreaterThan(0);
  expect(create().disabled).toBe(true);
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
});
it("ignores a late search response from the account that was in use before a reload", async () => {
  let finish: ((result: { options: Array<{ urn: string; name: string }> }) => void) | undefined;
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review() : new Promise(resolve => { finish = resolve; }));
  open();
  fireEvent.click(await ready());
  await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).includes("facet=titles") && String(p).includes("account_id=11"))).toBe(true));
  await connectionChange({ ...review(), accounts: [{ id: "22", name: "Account two", currency: "USD", funding_source: "provider" }] });
  finish?.({ options: [{ urn: "urn:li:title:1", name: "Old account result" }] });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("option", { name: "Old account result" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Old account result" })).toBeNull();
});

async function searchPlaces(label: "Include locations" | "Exclude locations", text: string) {
  fireEvent.change(await screen.findByLabelText(`${label} search`), { target: { value: text } });
  return screen.getByLabelText(`${label} search`).closest("fieldset")!;
}
const place = async (field: HTMLElement, name: string) => fireEvent.click(await within(field).findByRole("option", { name }));
it("starts from the suggested include location and sends chosen include and exclude locations to prepare", async () => {
  const approve = open();
  await screen.findByRole("button", { name: "Remove United States" });
  await place(await searchPlaces("Include locations", "Can"), "Canada");
  await place(await searchPlaces("Exclude locations", "Calif"), "California, United States");
  expect(api.mock.calls.filter(([p]) => p.includes("/locations?")).every(([p]) => p.startsWith("/api/channels/linkedin_ads/actions/action-1/locations?") && p.includes("account_id=11"))).toBe(true);
  await broadOnly();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body)).toMatchObject({
    locations: ["urn:li:geo:103644278", "urn:li:geo:101174742"], excluded_locations: ["urn:li:geo:102095887"],
  });
});
it("blocks creation with no included location", async () => {
  open();
  await broadOnly();
  await createReady();
  expect(screen.queryByText("Add at least one included location.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove United States" }));
  expect(create().disabled).toBe(true);
  const alert = screen.getByText("Add at least one included location.");
  expect(alert.getAttribute("role")).toBe("alert");
  expect(alert.className).toContain("text-danger");
  expect(screen.getByText("EU and EEA locations can be excluded but not included yet.")).toBeTruthy();
  expect(screen.queryByText(/runs only in included locations/)).toBeNull();
  fireEvent.click(create());
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
  await place(await searchPlaces("Include locations", "Can"), "Canada");
  expect(screen.queryByText("Add at least one included location.")).toBeNull();
  await createReady();
});
it("blocks a place chosen in both lists and says why", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? { ...review(), suggested: { ...review().suggested, locations: [{ id: "urn:li:geo:101174742", name: "Canada" }] } }
    : path.includes("/locations?") ? { locations: [{ id: "urn:li:geo:101174742", name: "Canada" }] } : { exact_change: { rows: [] } });
  open();
  await broadOnly();
  await place(await searchPlaces("Exclude locations", "Can"), "Canada");
  expect(await screen.findByText("A location cannot be both included and excluded.")).toBeTruthy();
  expect(create().disabled).toBe(true);
  fireEvent.click(create());
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
});
it("offers EU and EEA places only under Exclude, says why under Include, and still adds a non-EU include", async () => {
  const germany = [{ id: "urn:li:geo:101282230", name: "Germany", eu: true, includable: false }, { id: "urn:li:geo:100000001", name: "Bavaria, Germany", eu: true, includable: false }, { id: "urn:li:geo:100000002", name: "Greater Munich Metropolitan Area", eu: false, includable: false }];
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review()
    : path.includes("/locations?") ? { locations: path.includes("q=Can") ? [{ id: "urn:li:geo:101174742", name: "Canada", eu: false, includable: true }] : germany }
    : { exact_change: { rows: [] } });
  const approve = open();
  await screen.findByRole("button", { name: "Remove United States" });
  const includeField = screen.getByLabelText("Include locations search").closest("fieldset")!;
  const excludeField = screen.getByLabelText("Exclude locations search").closest("fieldset")!;
  await searchPlaces("Include locations", "Germany");
  const rows = await within(includeField).findAllByRole("option");
  expect(rows.map(r => [r.textContent, r.getAttribute("aria-disabled")])).toEqual([
    ["GermanyEU and EEA places can only be excluded for now.", "true"],
    ["Bavaria, GermanyEU and EEA places can only be excluded for now.", "true"],
    ["Greater Munich Metropolitan AreaThis place does not name its country, so it can only be excluded for now.", "true"],
  ]);
  const input = screen.getByLabelText("Include locations search");
  for (const row of rows) fireEvent.click(row);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Germany" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Bavaria, Germany" })).toBeNull();
  await searchPlaces("Exclude locations", "Germany");
  await place(excludeField, "Germany");
  await place(excludeField, "Bavaria, Germany");
  expect(excludeField.textContent).not.toContain("only be excluded");
  await place(await searchPlaces("Include locations", "Can"), "Canada");
  await broadOnly();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body)).toMatchObject({
    locations: ["urn:li:geo:103644278", "urn:li:geo:101174742"], excluded_locations: ["urn:li:geo:101282230", "urn:li:geo:100000001"],
  });
});
it("tells the founder which of Zavi's suggested places it could not pre-fill", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? { ...review(), suggested: { ...review().suggested, unresolved_locations: ["Germany", "Springfeld (exclude)"] } } : { exact_change: { rows: [] } });
  open();
  expect(await screen.findByText(/Zavi also suggested Germany, Springfeld \(exclude\), which it could not add for you: no single LinkedIn location matched/)).toBeTruthy();
});

it("when none of Zavi's places could be used, it says no place was filled in and Create stays off", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? { ...review(), suggested: { ...review().suggested, locations: [], unresolved_locations: ["Germany"] } } : { exact_change: { rows: [] } });
  open();
  const note = await screen.findByText(/Zavi could not use Germany for this campaign, so it filled in no location/);
  expect(note.getAttribute("role")).toBe("status");
  expect(note.textContent).not.toContain("also suggested");
  expect(screen.queryByText(/United States/)).toBeNull();
  expect((create() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(create());
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
});

const postField = () => screen.getByPlaceholderText("https://www.linkedin.com/posts/…") as HTMLInputElement;
const described = (input: HTMLElement) => (input.getAttribute("aria-describedby") ?? "").split(" ").map(id => document.getElementById(id)).filter(Boolean) as HTMLElement[];
async function readyExceptPost() {
  const approve = open();
  await broadOnly();
  await createReady();
  return approve;
}
it("keeps Create disabled until the pasted post is a LinkedIn post link, and sends nothing before", async () => {
  const approve = await readyExceptPost();
  await createReady();
  fireEvent.change(postField(), { target: { value: "" } });
  expect(create().disabled).toBe(true);
  fireEvent.change(postField(), { target: { value: "https://www.linkedin.com/company/acme/" } });
  expect(create().disabled).toBe(true);
  expect(postField().getAttribute("aria-invalid")).toBe("true");
  expect(described(postField()).some(el => /does not recognise this as a LinkedIn post link/.test(el.textContent ?? "") && postField().closest("label")!.contains(el))).toBe(true);
  fireEvent.submit(create().form!);
  fireEvent.click(create());
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
  fireEvent.change(postField(), { target: { value: "https://www.linkedin.com/posts/acme_launch-activity-7234567890123456789-AbCd?utm_source=share" } });
  await createReady();
  expect(postField().getAttribute("aria-invalid")).toBe("false");
});
it("shows a page-mismatch refusal on the post field, scrolls to it, and keeps Create disabled until the post changes", async () => {
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = function () { scrolled.push(this); };
  const mismatch = "This post was not published by the company page this ad account advertises for, and LinkedIn only promotes posts from that page. Paste the link to one of that page's posts, or choose another ad account. Nothing was created.";
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review();
    if (path.endsWith("/prepare")) throw Object.assign(new Error(mismatch), { status: 422, code: "linkedin_ads_post_page_mismatch" });
    return { exact_change: { rows: [] } };
  });
  const approve = await readyExceptPost();
  fireEvent.click(create());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(mismatch);
  expect(postField().closest("label")!.contains(alert)).toBe(true);
  expect(described(postField())).toContain(alert);
  expect(postField().getAttribute("aria-invalid")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(postField()));
  expect(scrolled).toContain(alert);
  expect(screen.getAllByText(mismatch)).toHaveLength(1);
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  expect(api.mock.calls.filter(([p]) => p.endsWith("/prepare"))).toHaveLength(1);
  expect(approve).not.toHaveBeenCalled();
  fireEvent.change(postField(), { target: { value: "urn:li:ugcPost:7300000000000000000" } });
  expect(screen.queryByText(mismatch)).toBeNull();
  await createReady();
});
it("marks Zavi's starting budget with a badge beside the label and one short hint, and drops the badge once the founder changes it", async () => {
  open();
  const input = await screen.findByLabelText("Spend up to, per day (USD)");
  const chip = screen.getByTestId("starter-budget");
  expect(chip.textContent).toBe("Zavi's pick");
  expect(chip.parentElement!.textContent).toBe("Spend up to, per dayZavi's pick");
  expect(chip.parentElement!.contains(input)).toBe(false);
  const field = input.closest("label")!;
  expect(field.textContent).toBe("Spend up to, per dayZavi's pickUSDDaily average. Nothing spends until you launch.");
  expect(within(field).getByText("Daily average. Nothing spends until you launch.")).toBeTruthy();
  expect(screen.getByLabelText("Maximum bid per click (USD)").closest("label")!.textContent).toBe("Maximum bid per clickUSD");
  fireEvent.change(input, { target: { value: "20" } });
  expect(screen.queryByTestId("starter-budget")).toBeNull();
});
it("does not credit Zavi with a draft the founder may have started while the review loads", async () => {
  let release!: (v: unknown) => void;
  api.mockImplementation((path: string) => path.endsWith("/review") ? new Promise(r => { release = r; }) : Promise.resolve({}));
  open();
  expect(screen.getByRole("status").textContent).toBe("Reading the draft…");
  expect(document.body.textContent).not.toMatch(/Zavi.s draft/);
  expect(document.body.textContent).not.toMatch(/saved post/);
  expect(screen.getByText("Reading the post…")).toBeTruthy();
  release(review());
  await screen.findByText("Company post");
  expect(screen.queryByText("Reading the draft…")).toBeNull();
});
const inrReview = (min: string | null) => ({ ...review(), accounts: [{ id: "33", name: "Acme India", currency: "INR", min_daily_budget: min, funding_source: "provider" }], suggested: { ...review().suggested, daily_budget: null, unit_cost: null } });
it("holds a non-USD budget to LinkedIn's floor in the account's own currency and sends nothing below it", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? inrReview("870") : { exact_change: { rows: [] } });
  const approve = open();
  const budget = await screen.findByLabelText("Spend up to, per day (INR)");
  await broadOnly();
  fireEvent.change(screen.getByLabelText("Maximum bid per click (INR)"), { target: { value: "50" } });
  fireEvent.change(budget, { target: { value: "869.99" } });
  expect(screen.getByRole("alert").textContent).toBe("LinkedIn's minimum daily budget for this account is 870 INR (about 10 USD).");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
  fireEvent.change(budget, { target: { value: "870" } });
  expect(screen.queryByRole("alert")).toBeNull();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body)).toMatchObject({ currency: "INR", daily_budget: "870.00", unit_cost: "50.00" });
});
it("takes LinkedIn's USD floor from the shared ad constraint for both the USD minimum and the non-USD hint", async () => {
  floor.usd = 12;
  const approve = open();
  const budget = await screen.findByLabelText("Spend up to, per day (USD)");
  fireEvent.change(budget, { target: { value: "11" } });
  expect(screen.getByRole("alert").textContent).toBe("LinkedIn's minimum daily budget is 12 USD.");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
  cleanup();
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? inrReview("870") : { exact_change: { rows: [] } });
  open();
  const inrBudget = await screen.findByLabelText("Spend up to, per day (INR)");
  fireEvent.change(inrBudget, { target: { value: "869.99" } });
  expect(within(inrBudget.closest("label")!).getByRole("alert").textContent).toBe("LinkedIn's minimum daily budget for this account is 870 INR (about 12 USD).");
});
it("shows the server's floor refusal when the account's floor could not be read in advance", async () => {
  const refusal = "LinkedIn's minimum daily budget for this account is 870 INR (about 10 USD).";
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return inrReview(null);
    if (path.endsWith("/prepare")) throw new Error(refusal);
    return {};
  });
  const approve = open();
  fireEvent.change(await screen.findByLabelText("Spend up to, per day (INR)"), { target: { value: "500" } });
  fireEvent.change(screen.getByLabelText("Maximum bid per click (INR)"), { target: { value: "50" } });
  await broadOnly();
  await createReady();
  fireEvent.click(create());
  expect((await screen.findByRole("alert")).textContent).toBe(refusal);
  expect(approve).not.toHaveBeenCalled();
});
it("names the billing of the account in use in the founder's words", async () => {
  const accounts = [{ id: "11", name: "Account one", currency: "USD", funding_source: "wallet", account_binding_id: "b1" }, { id: "22", name: "Account two", currency: "USD", funding_source: "provider", account_binding_id: "b2" }];
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? { ...review(), accounts, selected_account_binding_id: "b1" } : { exact_change: { rows: [] } });
  open();
  await screen.findByText("Pilot");
  expect(screen.getByTestId("account-billing").textContent).toBe("This campaign runs on the Zavi account and uses your shared ads balance when you approve its launch.");
  await connectionChange({ ...review(), accounts, selected_account_binding_id: "b2" });
  expect(screen.getByTestId("account-billing").textContent).toBe("This campaign runs on your connected LinkedIn ad account. LinkedIn bills it directly.");
  expect(screen.queryByRole("combobox", { name: "Ad account" })).toBeNull();
});
it("says why Create is off when the bid is above the daily budget, and sends nothing", async () => {
  const approve = open();
  const bid = await screen.findByLabelText("Maximum bid per click (USD)");
  await broadOnly();
  const calls = api.mock.calls.length;
  fireEvent.change(bid, { target: { value: "15.01" } });
  expect(screen.getByRole("alert").textContent).toBe("The maximum bid cannot be higher than the daily budget.");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  fireEvent.click(create());
  await new Promise(r => setTimeout(r, 20));
  expect(api.mock.calls.length).toBe(calls);
  expect(approve).not.toHaveBeenCalled();
  fireEvent.change(bid, { target: { value: "15" } });
  expect(screen.queryByRole("alert")).toBeNull();
  await createReady();
});
it("stops saying the post is being read once the draft fails to load", async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) throw new Error("LinkedIn Ads is busy right now");
    return { options: [] };
  });
  open();
  expect(screen.getByText("Reading the post…")).toBeTruthy();
  await screen.findByText("LinkedIn Ads is busy right now");
  expect(screen.queryByText("Reading the post…")).toBeNull();
  expect(screen.queryByText("Reading the draft…")).toBeNull();
  expect(screen.getByText("The post preview is not available because the draft did not load.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create paused campaign" })).toBeNull();
});
it("asks LinkedIn once for a job-title search the founder types again", async () => {
  open(); await ready();
  const field = screen.getByRole("combobox", { name: "Job titles" });
  const searches = (q: string) => api.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("/targeting?") && p.includes("facet=titles") && new URL(p, "http://x").searchParams.get("query") === q);
  fireEvent.change(field, { target: { value: "Chief" } });
  await waitFor(() => expect(searches("Chief")).toHaveLength(1));
  await screen.findByRole("option", { name: "Chief Executive Officer" });
  fireEvent.change(field, { target: { value: "Chief Ex" } });
  await waitFor(() => expect(searches("Chief Ex")).toHaveLength(1));
  fireEvent.change(field, { target: { value: "Chief" } });
  await screen.findByRole("option", { name: "Chief Executive Officer" });
  await new Promise((r) => setTimeout(r, 400));
  expect(searches("Chief")).toHaveLength(1);
});
it("a reopened review sheet reuses the audience lists and job-title searches LinkedIn already answered", async () => {
  open(); await ready();
  const targeting = () => api.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("/targeting?"));
  const lists = (facet: string) => targeting().filter((p) => p.includes("account_id=11") && p.includes(`facet=${facet}`));
  await waitFor(() => expect(lists("seniorities")).toHaveLength(1));
  await waitFor(() => expect(lists("staffCountRanges")).toHaveLength(1));
  fireEvent.change(screen.getByRole("combobox", { name: "Job titles" }), { target: { value: "Chief" } });
  await screen.findByRole("option", { name: "Chief Executive Officer" });
  const asked = targeting().length;
  cleanup();
  open();
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Chief Executive Officer", pressed: false })).toHaveLength(2));
  fireEvent.change(screen.getByRole("combobox", { name: "Job titles" }), { target: { value: "Chief" } });
  await screen.findByRole("option", { name: "Chief Executive Officer" });
  await new Promise((r) => setTimeout(r, 400));
  expect(targeting()).toHaveLength(asked);
  expect(lists("seniorities")).toHaveLength(1);
});

it("a failed audience list is not remembered: reopening asks LinkedIn again", async () => {
  let down = true;
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review() : path.includes("/targeting?")
    ? (down ? Promise.reject(new Error("LinkedIn is unavailable")) : { options: [{ urn: "urn:li:seniority:1", name: "Owner" }] })
    : { exact_change: { rows: [] } });
  open();
  await waitFor(() => expect(screen.getAllByText(/LinkedIn is unavailable/).length).toBeGreaterThan(0));
  const lists = () => api.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("/targeting?") && p.includes("facet=seniorities"));
  expect(lists()).toHaveLength(1);
  cleanup();
  down = false;
  open();
  await screen.findAllByRole("button", { name: "Owner", pressed: false });
  expect(lists()).toHaveLength(2);
});
it("brings a prepare refusal into view from the footer button, and leaves Create ready to try again", async () => {
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = function () { scrolled.push(this); };
  const refusal = "LinkedIn Ads is not available for this workspace.";
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review();
    if (path.includes("/targeting?")) return { options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] };
    if (path.endsWith("/prepare")) throw Object.assign(new Error(refusal), { status: 409 });
    return {};
  });
  const approve = open();
  await ready();
  await selectTitle();
  fireEvent.click(create());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(refusal);
  await waitFor(() => expect(scrolled).toContain(alert));
  expect(approve).not.toHaveBeenCalled();
  await createReady();
});
it.each(["", "0", "0.009"])("says why Create is off when the bid is %j, beside the bid field, and sends nothing", async (value) => {
  const approve = open();
  const bid = await screen.findByLabelText("Maximum bid per click (USD)");
  await broadOnly();
  await createReady();
  expect(screen.queryByRole("alert")).toBeNull();
  const calls = api.mock.calls.length;
  fireEvent.change(bid, { target: { value } });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("Enter a bid of at least 0.01.");
  expect(bid.closest("label")!.contains(alert)).toBe(true);
  expect(alert.className).toContain("text-danger");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  fireEvent.click(create());
  await new Promise(r => setTimeout(r, 20));
  expect(api.mock.calls.length).toBe(calls);
  expect(approve).not.toHaveBeenCalled();
  fireEvent.change(bid, { target: { value: "0.01" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(bid.closest("label")!.textContent).toBe("Maximum bid per clickUSD");
  await createReady();
});

it("a review reopened after the account in use changed starts on the new account and drops the audience picked for the old one", async () => {
  const accountOne = { id: "11", name: "Account one", currency: "USD", funding_source: "provider" };
  const accountTwo = { id: "22", name: "Account two", currency: "USD", funding_source: "provider" };
  let accounts = [accountOne, accountTwo];
  const fallback = api.getMockImplementation()!;
  api.mockImplementation((path: string, init?: unknown) => path.endsWith("/review") ? Promise.resolve({ ...review(), accounts }) : fallback(path, init));
  const reopen = async (reads: number) => {
    cleanup();
    invalidateCampaignReviews();
    open();
    await waitFor(() => expect(reviewReads()).toBe(reads));
    await screen.findAllByRole("button", { name: "Chief Executive Officer" });
  };
  const listsFor = (account: string) => api.mock.calls.filter(([p]) => String(p).includes("/targeting?") && String(p).includes(`account_id=${account}`)).length;
  closeCampaignReview(action.id);
  openCampaignReview(action.id);
  try {
    open(); await screen.findAllByRole("button", { name: "Chief Executive Officer" });
    await selectTitle();
    expect(screen.getByRole("button", { name: "Remove Chief Executive Officer" })).toBeTruthy();
    await waitFor(() => expect(listsFor("11")).toBeGreaterThan(0));
    expect(listsFor("22")).toBe(0);
    await reopen(2);
    expect(screen.getByRole("button", { name: "Remove Chief Executive Officer" })).toBeTruthy();
    accounts = [accountTwo, accountOne];
    await reopen(3);
    await waitFor(() => expect(listsFor("22")).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Remove Chief Executive Officer" })).toBeNull();
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    await new Promise((r) => setTimeout(r, 0));
    expect(api.mock.calls.some(([p]) => String(p).endsWith("/prepare"))).toBe(false);
    await selectTitle();
    await createReady();
    fireEvent.click(create());
    await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).endsWith("/prepare"))).toBe(true));
    expect(bodyOf()).toMatchObject({ account_id: "22", audience: { titles: ["urn:li:title:1"] } });
  } finally {
    closeCampaignReview(action.id);
  }
});
const movedReview = (second: { id: string; currency: string; min?: string }) => ({ ...review(), accounts: [{ id: second.id, name: "Account two", currency: second.currency, min_daily_budget: second.min ?? null, funding_source: "provider" }] });
it.each([["INR", "870"], ["EUR", "10"]])("never submits USD budget and bid under %s after a reload moves the campaign to another account, and asks for re-entry", async (cur, min) => {
  const approve = open(); await ready(); await selectTitle();
  fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "50" } });
  fireEvent.change(screen.getByLabelText("Maximum bid per click (USD)"), { target: { value: "7" } });
  await createReady();
  await connectionChange(movedReview({ id: "22", currency: cur, min }));
  const budget = screen.getByLabelText(`Spend up to, per day (${cur})`) as HTMLInputElement;
  const bid = screen.getByLabelText(`Maximum bid per click (${cur})`) as HTMLInputElement;
  expect(budget.value).toBe("");
  expect(bid.value).toBe("");
  expect(screen.getByText(/bills in/).textContent).toContain(`bills in ${cur}, not USD`);
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  await new Promise((r) => setTimeout(r, 0));
  expect(api.mock.calls.some(([p]) => String(p).endsWith("/prepare"))).toBe(false);
  fireEvent.change(budget, { target: { value: "1000" } });
  fireEvent.change(bid, { target: { value: "20" } });
  await selectTitle();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(bodyOf()).toMatchObject({ account_id: "22", currency: cur, daily_budget: "1000.00", unit_cost: "20.00" });
});
it("keeps budget and bid when a reload moves the campaign to an account in the same currency", async () => {
  const approve = open(); await ready(); await selectTitle();
  fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "50" } });
  fireEvent.change(screen.getByLabelText("Maximum bid per click (USD)"), { target: { value: "7" } });
  await connectionChange(movedReview({ id: "22", currency: "USD" }));
  expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("50");
  expect((screen.getByLabelText("Maximum bid per click (USD)") as HTMLInputElement).value).toBe("7");
  expect(screen.queryByText(/bills in/)).toBeNull();
  await selectTitle();
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(bodyOf()).toMatchObject({ account_id: "22", currency: "USD", daily_budget: "50.00", unit_cost: "7.00" });
});

describe("a restored draft whose account or currency moved", () => {
  const usdOne = { id: "11", name: "Account one", currency: "USD", min_daily_budget: "10", funding_source: "provider" };
  const usdTwo = { id: "22", name: "Account two", currency: "USD", min_daily_budget: "10", funding_source: "provider" };
  const inrOne = { ...usdOne, currency: "INR", min_daily_budget: "870" };
  const inrNew = { id: "33", name: "Acme India", currency: "INR", min_daily_budget: "870", funding_source: "provider", account_binding_id: "b-inr" };
  let accounts: unknown[];
  let selected: string | null = null;
  const budgetField = (cur: string) => screen.getByLabelText(`Spend up to, per day (${cur})`) as HTMLInputElement;
  const bidField = (cur: string) => screen.getByLabelText(`Maximum bid per click (${cur})`) as HTMLInputElement;
  const prepares = () => api.mock.calls.filter(([p]) => String(p).endsWith("/prepare"));
  const stage = async () => {
    const fallback = api.getMockImplementation()!;
    api.mockImplementation((path: string, init?: unknown) => path.endsWith("/review") ? Promise.resolve({ ...review(), accounts, selected_account_binding_id: selected, suggested: { ...review().suggested, daily_budget: null, unit_cost: null } }) : fallback(path, init));
    closeCampaignReview(action.id);
    openCampaignReview(action.id);
    invalidateCampaignReviews();
    open();
    await screen.findAllByRole("button", { name: "Chief Executive Officer" });
  };
  const typeMoney = (cur: string, budget: string, bid: string) => {
    fireEvent.change(budgetField(cur), { target: { value: budget } });
    fireEvent.change(bidField(cur), { target: { value: bid } });
  };
  const reopenFresh = async () => {
    cleanup();
    invalidateCampaignReviews();
    open();
    await screen.findAllByRole("button", { name: "Chief Executive Officer" });
  };
  const expectCleared = async (cur: string) => {
    await waitFor(() => expect(budgetField(cur).value).toBe(""));
    expect(bidField(cur).value).toBe("");
    expect(screen.getByText(`Budget and bid were cleared because this account bills in ${cur}, not USD. Enter them again in ${cur}.`)).toBeTruthy();
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    await new Promise((r) => setTimeout(r, 0));
    expect(prepares()).toHaveLength(0);
  };
  afterEach(() => { selected = null; closeCampaignReview(action.id); });

  it("the same account now billing in another currency never carries 50 dollars over as 50 rupees", async () => {
    accounts = [usdOne];
    await stage();
    typeMoney("USD", "50", "7");
    accounts = [inrOne];
    await reopenFresh();
    await expectCleared("INR");
    typeMoney("INR", "1000", "20");
    await selectTitle();
    await waitFor(() => expect(create().disabled).toBe(false));
    fireEvent.click(create());
    await waitFor(() => expect(prepares()).toHaveLength(1));
    expect(JSON.parse(prepares()[0][1].body)).toMatchObject({ currency: "INR", daily_budget: "1000.00", unit_cost: "20.00" });
  });

  it("a default account replaced by one in another currency clears the money too", async () => {
    accounts = [usdOne, usdTwo];
    await stage();
    typeMoney("USD", "50", "7");
    accounts = [inrNew, usdOne];
    await reopenFresh();
    await expectCleared("INR");
    expect(api.mock.calls.some(([p]) => String(p).includes("/targeting?") && String(p).includes("account_id=33"))).toBe(true);
  });

  it("an account in use that was removed falls back to an account in another currency and clears the money", async () => {
    accounts = [usdOne, inrNew];
    selected = "b-inr";
    await stage();
    expect(screen.getByLabelText("Spend up to, per day (INR)")).toBeTruthy();
    typeMoney("INR", "1000", "20");
    accounts = [usdOne, usdTwo];
    selected = null;
    await reopenFresh();
    await waitFor(() => expect(budgetField("USD").value).toBe(""));
    expect(bidField("USD").value).toBe("");
    expect(screen.getByText("Budget and bid were cleared because this account bills in USD, not INR. Enter them again in USD.")).toBeTruthy();
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    await new Promise((r) => setTimeout(r, 0));
    expect(prepares()).toHaveLength(0);
  });

  it("a warm reopen painting from the cached review clears on the very first render, with no read behind it", async () => {
    accounts = [usdOne];
    await stage();
    typeMoney("USD", "50", "7");
    cleanup();
    invalidateCampaignReviews();
    accounts = [inrOne];
    const path = `${spec.actionReviewPath}/${action.id}/review`;
    const release = holdCampaignReview(path, action.post_revision);
    await waitFor(() => expect(cachedCampaignReview(path, action.post_revision)).toBeTruthy());
    release();
    const reads = api.mock.calls.filter(([p]) => String(p).endsWith("/review")).length;
    open();
    expect(budgetField("INR").value).toBe("");
    expect(bidField("INR").value).toBe("");
    expect(screen.getByText("Budget and bid were cleared because this account bills in INR, not USD. Enter them again in INR.")).toBeTruthy();
    expect(api.mock.calls.filter(([p]) => String(p).endsWith("/review")).length).toBe(reads);
  });

  it("a revision reload that drops the account in use and snaps back to another currency's account does not keep what was typed for the old one", async () => {
    closeCampaignReview(action.id);
    invalidateCampaignReviews();
    accounts = [usdOne, inrNew];
    selected = "b-inr";
    const fallback = api.getMockImplementation()!;
    api.mockImplementation((path: string, init?: unknown) => path.endsWith("/review") ? Promise.resolve({ ...review(), accounts, selected_account_binding_id: selected, suggested: { ...review().suggested, daily_budget: null, unit_cost: null } }) : fallback(path, init));
    const handlers = { onApprove: vi.fn().mockResolvedValue(true), onSetStatus: vi.fn(), onRedo: vi.fn() };
    const view = render(<SponsoredPostReview action={action} spec={spec} handlers={handlers} onPrepared={vi.fn()} onClose={vi.fn()} />);
    await screen.findAllByRole("button", { name: "Chief Executive Officer" });
    typeMoney("INR", "1000", "20");
    accounts = [usdOne];
    selected = null;
    view.rerender(<SponsoredPostReview action={{ ...action, post_revision: "r2" } as ActionItem} spec={spec} handlers={handlers} onPrepared={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(budgetField("USD").value).toBe(""));
    expect(bidField("USD").value).toBe("");
    expect(screen.getByText("Budget and bid were cleared because this account bills in USD, not INR. Enter them again in USD.")).toBeTruthy();
    fireEvent.click(create());
    await new Promise((r) => setTimeout(r, 0));
    expect(prepares()).toHaveLength(0);
  });

  it("non-regression guard: the same currency keeps what the founder typed across a reopen, even on another account", async () => {
    accounts = [usdOne, usdTwo];
    await stage();
    typeMoney("USD", "50", "7");
    accounts = [usdTwo, usdOne];
    await reopenFresh();
    expect(budgetField("USD").value).toBe("50");
    expect(bidField("USD").value).toBe("7");
    expect(screen.queryByText(/Budget and bid were cleared/)).toBeNull();
  });

  it("non-regression guard: blank money is not reported as cleared when the currency moves", async () => {
    accounts = [usdOne];
    await stage();
    accounts = [inrOne];
    await reopenFresh();
    expect(budgetField("INR").value).toBe("");
    expect(screen.queryByText(/Budget and bid were cleared/)).toBeNull();
  });
});

const noSuggestion = () => { const r = review(); return { ...r, draft: { ...r.draft, audience_suggestions: {} } }; };
it("a founder-started draft cannot create a whole-country audience without saying so", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? noSuggestion() : path.includes("/targeting?")
    ? { options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] }
    : path.includes("/locations?") ? { locations: [] } : { exact_change: { rows: [] } });
  open();
  const ack = await screen.findByRole("checkbox", { name: /Show this to everyone in these locations/ });
  expect(create().disabled).toBe(true);
  fireEvent.click(create());
  await new Promise((r) => setTimeout(r, 0));
  expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(false);
  fireEvent.click(ack);
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(true));
  expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body)).toMatchObject({ use_broad_audience: true });
});
it("choosing a real audience needs no acknowledgement and never sends one", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? noSuggestion() : path.includes("/targeting?")
    ? { options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] }
    : path.includes("/locations?") ? { locations: [] } : { exact_change: { rows: [] } });
  open();
  await selectTitle();
  expect(screen.queryByRole("checkbox", { name: /Show this to everyone/ })).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(api.mock.calls.some(([p]) => p.endsWith("/prepare"))).toBe(true));
  expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith("/prepare"))![1].body).use_broad_audience).not.toBe(true);
});

it("must catch: a grown ad account list while the review is open keeps the account in use, money, places, audience and post", async () => {
  const approve = open(); await ready();
  const custom = "https://www.linkedin.com/posts/zavi-labs_launch-share-7300000000000000001-AbCd";
  fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "40" } });
  fireEvent.change(screen.getByLabelText("Maximum bid per click (USD)"), { target: { value: "5" } });
  await place(await searchPlaces("Include locations", "Can"), "Canada");
  fireEvent.click(screen.getByRole("button", { name: "Remove United States" }));
  await selectTitle();
  fireEvent.change(screen.getByLabelText("The post to promote"), { target: { value: custom } });
  await connectionChange({ ...review(), accounts: [...review().accounts, { id: "55", name: "Account three", currency: "USD", funding_source: "provider" }] });
  expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("40");
  expect((screen.getByLabelText("Maximum bid per click (USD)") as HTMLInputElement).value).toBe("5");
  expect(screen.getByRole("button", { name: "Remove Canada" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove United States" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove Chief Executive Officer" })).toBeTruthy();
  expect((screen.getByLabelText("The post to promote") as HTMLInputElement).value).toBe(custom);
  await createReady();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(bodyOf()).toMatchObject({
    account_id: "11", daily_budget: "40.00", unit_cost: "5.00", locations: ["urn:li:geo:101174742"], audience: { titles: ["urn:li:title:1"] }, post: custom,
  });
  expect(api.mock.calls.some(([p]) => String(p).includes("account_id=55"))).toBe(false);
});
it("must catch: a non-USD account with no starter budget says a budget is needed, and a budget above 100,000 can be created", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? inrReview("870") : { exact_change: { rows: [] } });
  const approve = open();
  const budget = await screen.findByLabelText("Spend up to, per day (INR)") as HTMLInputElement;
  expect(budget.value).toBe("");
  expect(budget.hasAttribute("max")).toBe(false);
  await broadOnly();
  fireEvent.change(screen.getByLabelText("Maximum bid per click (INR)"), { target: { value: "500" } });
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Enter a daily budget.");
  fireEvent.change(budget, { target: { value: "250000" } });
  await createReady();
  expect(screen.queryByTestId("create-blocked-reason")).toBeNull();
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(api.mock.calls.find(([p]) => String(p).endsWith("/prepare"))![1].body)).toMatchObject({ currency: "INR", daily_budget: "250000.00", unit_cost: "500.00" });
});
