import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../platforms", () => ({ platformFor: () => ({ name: "LinkedIn Ads" }) }));

import { BoundAdsCampaigns } from "./BoundAdsCampaigns";

const A = "10000000-0000-4000-8000-00000000000a";
const B = "10000000-0000-4000-8000-00000000000b";
const END = Date.now() + 3 * 86400000;
let rows: Array<Record<string, unknown>>;
let launchAnswer: (n: number) => Promise<unknown>;
let pauseAnswer: () => Promise<unknown>;
let budget: Record<string, unknown> | null;
let review: (id: string) => Record<string, unknown>;

const launchPosts = () =>
  api.mock.calls
    .filter(([p, o]) => /\/launch$/.test(String(p)) && (o as RequestInit | undefined)?.method === "POST")
    .map(([p, o]) => ({ path: String(p), ...JSON.parse(String((o as RequestInit).body)) }));
const rowOf = (name: string) => {
  const row = Array.from(document.querySelectorAll("[data-campaign-row]")).find((li) => li.textContent?.includes(name));
  if (!row) throw new Error(`no row ${name}`);
  return row as HTMLElement;
};
const approve = () => screen.getByRole("button", { name: /Approve and launch|Try again/ }) as HTMLButtonElement;

beforeEach(() => {
  api.mockReset();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = () => undefined;
  rows = [
    { id: A, provider_campaign_id: "111", funding_source: "provider", name: "Alpha", status: "PAUSED" },
    { id: B, provider_campaign_id: "222", funding_source: "provider", name: "Bravo", status: "ACTIVE" },
  ];
  budget = { status: "active" };
  launchAnswer = async () => ({ status: "active" });
  pauseAnswer = async () => ({ status: "paused" });
  review = (id) => ({
    campaign_binding_id: id, name: id === A ? "Alpha" : "Bravo", account_id: "42", funding_source: "provider", status: "PAUSED",
    snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, end_time: END, ads: [{ id: "8", status: "PAUSED" }],
  });
  let launches = 0;
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (path.includes("?platform=")) return { campaigns: rows };
    if (path === "/api/workspace/ad-budget") return { budget };
    if (/\/pause$/.test(path) && opts?.method === "POST") return pauseAnswer();
    const launch = /^\/api\/ads\/campaigns\/([^/]+)\/launch$/.exec(path);
    if (launch && opts?.method === "POST") return launchAnswer(++launches);
    if (launch) return review(launch[1]);
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

it("relaunches a campaign paused after a confirmed launch with a fresh request id, same total and end date", async () => {
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
  await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
  fireEvent.click(within(rowOf("Alpha")).getByRole("button", { name: "Pause" }));
  await screen.findByText("LinkedIn confirmed the campaign is paused.");
  fireEvent.click(within(rowOf("Alpha")).getByRole("button", { name: "Review launch" }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
  await waitFor(() => expect(launchPosts()).toHaveLength(2));
  const [first, second] = launchPosts();
  expect(second.total_budget_cents).toBe(first.total_budget_cents);
  expect(second.end_time).toBe(first.end_time);
  expect(second.request_id).not.toBe(first.request_id);
  expect(sessionStorage.length).toBe(0);
});

it("retries a lost launch reply with the same request id, so the launch cannot be sent twice", async () => {
  launchAnswer = async (n) => {
    if (n === 1) throw new TypeError("Failed to fetch");
    return { status: "already_requested" };
  };
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
  const alert = await screen.findByText(/didn't hear back/);
  expect(alert.textContent).toMatch(/may or may not have gone live/);
  expect(alert.textContent).toMatch(/Nothing is charged twice/);
  expect(alert.textContent).not.toMatch(/Failed to fetch|Refresh before retrying/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(launchPosts()).toHaveLength(2));
  const [first, second] = launchPosts();
  expect(second.request_id).toBe(first.request_id);
});

it("keeps the pending request id and the typed total across a page refresh, so Try again reuses it", async () => {
  launchAnswer = async (n) => {
    if (n === 1) throw Object.assign(new Error("The server response could not be read. Refresh before retrying."), { reply_lost: true });
    return { status: "active" };
  };
  const first = render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  fireEvent.change(await screen.findByLabelText("Total campaign budget (USD)"), { target: { value: "250" } });
  fireEvent.click(approve());
  await screen.findByText(/didn't hear back/);
  expect(screen.queryByText(/Refresh before retrying/)).toBeNull();
  first.unmount();
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  expect(((await screen.findByLabelText("Total campaign budget (USD)")) as HTMLInputElement).value).toBe("250");
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
  const [a, b] = launchPosts();
  expect(b.total_budget_cents).toBe(25000);
  expect(b.request_id).toBe(a.request_id);
  expect(sessionStorage.length).toBe(0);
});

it("a server refusal keeps its own words and the Approve button, not the lost-reply message", async () => {
  launchAnswer = async () => { throw Object.assign(new Error("Another change to this campaign is still finishing. Try again in a minute."), { status: 409, code: "ads_launch_conflict" }); };
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
  await screen.findByText("Another change to this campaign is still finishing. Try again in a minute.");
  expect(screen.queryByText(/didn't hear back/)).toBeNull();
  expect(screen.getByRole("button", { name: /Approve and launch/ })).toBeTruthy();
});

it("still offers a fresh launch when the browser blocks session storage", async () => {
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  try {
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
    await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
    expect(launchPosts()).toHaveLength(1);
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

it("pausing another campaign keeps the open launch form and the total and end date typed in it", async () => {
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  const total = (await screen.findByLabelText("Total campaign budget (USD)")) as HTMLInputElement;
  fireEvent.change(total, { target: { value: "321" } });
  fireEvent.click(within(rowOf("Bravo")).getByRole("button", { name: "Pause" }));
  await screen.findByText("LinkedIn confirmed the campaign is paused.");
  expect(((screen.getByLabelText("Total campaign budget (USD)")) as HTMLInputElement).value).toBe("321");
  expect(approve().disabled).toBe(false);
});

it("a queued pause of another campaign keeps the open launch form too", async () => {
  pauseAnswer = async () => { throw Object.assign(new Error("Pausing… Zavi keeps retrying."), { status: 503, code: "ads_pause_queued" }); };
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  fireEvent.change(await screen.findByLabelText("Total campaign budget (USD)"), { target: { value: "321" } });
  fireEvent.click(within(rowOf("Bravo")).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(within(rowOf("Bravo")).getByTestId("pause-pending")).toBeTruthy());
  expect(((screen.getByLabelText("Total campaign budget (USD)")) as HTMLInputElement).value).toBe("321");
});

it("pausing the campaign whose launch form is open still closes that form", async () => {
  rows = rows.map((r) => (r.id === B ? { ...r, status: "PAUSED" } : r));
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  await screen.findByLabelText("Total campaign budget (USD)");
  fireEvent.click(within(rowOf("Alpha")).getByRole("button", { name: "Pause" }));
  await screen.findByText("LinkedIn confirmed the campaign is paused.");
  expect(screen.queryByLabelText("Total campaign budget (USD)")).toBeNull();
});

it.each([
  ["USD", undefined, 6000, 50, /\$60\.00 a day, more than the \$50\.00 daily limit/],
  ["EUR", { units_per_usd: 0.8, as_of: "2026-11-01" }, 4400, 50, /€44\.00 a day \(about \$55\.00\), more than the \$50\.00 daily limit/],
])("refuses to approve a %s campaign whose daily budget is over the monthly budget's daily limit", async (currency, fx, daily, limit, copy) => {
  budget = { status: "active", left_usd: 5000, daily_limit_usd: limit };
  review = (id) => ({
    campaign_binding_id: id, name: "Alpha", account_id: "42", funding_source: "provider", status: "PAUSED", currency, ...(fx ? { fx } : {}),
    snapshot: "a".repeat(64), total_budget_cents: 100000, daily_budget_cents: daily, end_time: END, ads: [{ id: "8", status: "PAUSED" }],
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  const button = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const why = document.getElementById("launch-over-daily")!;
  expect(why.textContent).toMatch(copy);
  expect(button.getAttribute("aria-describedby")).toBe("launch-over-daily");
  fireEvent.submit(button.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(launchPosts()).toHaveLength(0);
});

it.each([
  ["no daily limit is set", { status: "active", left_usd: 5000, daily_limit_usd: null }],
  ["the daily limit field is absent", { status: "active", left_usd: 5000 }],
  ["the daily budget equals the limit", { status: "active", left_usd: 5000, daily_limit_usd: 60 }],
])("keeps Approve on when %s", async (_label, monthly) => {
  budget = monthly;
  review = (id) => ({
    campaign_binding_id: id, name: "Alpha", account_id: "42", funding_source: "provider", status: "PAUSED", currency: "USD",
    snapshot: "a".repeat(64), total_budget_cents: 100000, daily_budget_cents: 6000, end_time: END, ads: [{ id: "8", status: "PAUSED" }],
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
  const button = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(document.getElementById("launch-over-daily")).toBeNull();
});
it("a campaign on an ad account the workspace stopped or replaced keeps Pause but never offers Review launch", async () => {
  rows = [
    { id: A, provider_campaign_id: "111", funding_source: "provider", name: "Alpha", status: "PAUSED", pause_only: true },
    { id: B, provider_campaign_id: "222", funding_source: "provider", name: "Bravo", status: "ACTIVE", pause_only: true },
  ];
  render(<BoundAdsCampaigns platform="linkedin" />);
  const alpha = await waitFor(() => rowOf("Alpha"));
  expect(within(alpha).queryByRole("button", { name: "Review launch" })).toBeNull();
  expect(within(rowOf("Bravo")).queryByRole("button", { name: "Review launch" })).toBeNull();
  fireEvent.click(within(rowOf("Bravo")).getByRole("button", { name: "Pause" }));
  await screen.findByText("LinkedIn confirmed the campaign is paused.");
  expect(api.mock.calls.some(([p, o]) => /\/pause$/.test(String(p)) && (o as RequestInit | undefined)?.method === "POST")).toBe(true);
  expect(launchPosts()).toEqual([]);
});
