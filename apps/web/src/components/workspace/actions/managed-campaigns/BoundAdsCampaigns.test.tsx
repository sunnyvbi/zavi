// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const viewer = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => (viewer.role ? { role: viewer.role } : null),
}));
vi.mock("../platforms", () => ({
  platformFor: (slug:string) => slug==="linkedin_ads"?{name:"LinkedIn Ads"}:({
    name: "ChatGPT Ads",
    campaignWorkspace: {
      apiBase: "/api/channels/chatgpt_ads",
      controls: { resources: true },
    },
  }),
}));
vi.mock("./CampaignEditor", () => ({
  CampaignEditor: ({ spec, campaign, currency }: any) => (
    <div data-testid="editor">
      {spec.apiBase}:{campaign.id}:{currency}
    </div>
  ),
}));
vi.mock("./LaunchSheet", () => ({
  LaunchSheet: ({ spec, campaignId }: any) => (
    <div data-testid="launch">
      {spec.apiBase}:{campaignId}
    </div>
  ),
}));
import { BoundAdsCampaigns } from "./BoundAdsCampaigns";
import { useChannelActions } from "../useChannelActions";
import { announceChannelHistoryChanged } from "../useChannelHistory";
import { CHANNEL_DASHBOARD_STALE_EVENT, announceChannelDashboardStale, setCampaignStates } from "../campaignLinks";
import { makeAction } from "../__tests__/fixtures";
const id = "10000000-0000-4000-8000-000000000001";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  act(() => setCampaignStates("linkedin_ads", {}));
});
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  viewer.role = "owner";
  api.mockImplementation(async (path, opts) =>
    opts?.method === "POST"
      ? { ok: true }
      : path.includes("?platform=")
        ? {
            campaigns: [
              { id, provider_campaign_id: "12345", funding_source: "provider" },
            ],
          }
        : {
            campaign: { id, name: "Customer campaign", updated_at: 99 },
            campaign_name_prefix: "",
            currency: "EUR",
          },
  );
});
it("keeps editor requests on the campaign's internal account-bound URL", async () => {
  render(<BoundAdsCampaigns platform="chatgpt" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage ads" }));
  expect((await screen.findByTestId("editor")).textContent).toBe(
    `/api/ads/chatgpt:${id}:EUR`,
  );
  expect(api).toHaveBeenCalledWith(`/api/ads/chatgpt/campaigns/${id}`);
});
it("pauses the original campaign using its fresh provider version", async () => {
  render(<BoundAdsCampaigns platform="chatgpt" />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(`/api/ads/chatgpt/campaigns/${id}`, {
      method: "POST",
      body: JSON.stringify({ status: "paused", expected_updated_at: 99 }),
    }),
  );
});
it("opens launch on the exact binding even when the raw ID is reused", async () => {
  render(<BoundAdsCampaigns platform="chatgpt" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  expect(screen.getByTestId("launch").textContent).toBe(
    `/api/ads/chatgpt:${id}`,
  );
});

it("reviews non-USD LinkedIn caps above $5,000 in the shared component",async()=>{
 api.mockImplementation(async(path:string,opts?:any)=>opts?.method==="POST"?{status:"active"}:path==="/api/workspace/ad-budget"?{budget:{status:"active"}}:path.includes("?platform=")?{campaigns:[{id,provider_campaign_id:"12345",funding_source:"provider"}]}:{campaign_binding_id:id,name:"European campaign",account_id:"42",funding_source:"provider",status:"PAUSED",snapshot:"a".repeat(64),currency:"EUR",fx:{units_per_usd:0.8,as_of:"2026-10-13"},total_budget_cents:600000,end_time:Date.now()+86400000,ads:[{id:"8",status:"PAUSED"}]});
 render(<BoundAdsCampaigns platform="linkedin"/>);fireEvent.click(await screen.findByRole("button",{name:"Review launch"}));
 const budget=await screen.findByLabelText("Total campaign budget (EUR)");expect((budget as HTMLInputElement).max).toBe("");
 expect(screen.getByText(/Amounts are in EUR/).textContent).toContain("7500.00");
 const approve=screen.getByRole("button",{name:/Approve and launch/});expect((approve as HTMLButtonElement).disabled).toBe(false);fireEvent.click(approve);
 await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
 expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${id}/launch`,expect.objectContaining({method:"POST",body:expect.stringContaining('"total_budget_cents":600000')}));
 const sent=JSON.parse(String(api.mock.calls.find(([p,o]:any[])=>p===`/api/ads/campaigns/${id}/launch`&&o?.method==="POST")![1].body));
 expect(sent.reviewed_units_per_usd).toBe(0.8);
});

it.each([
  ["confirmed pre-write refusal", { status: 409, code: "ads_launch_not_sent" }, true],
  ["unclassified conflict", { status: 409, code: "ads_launch_conflict" }, false],
  ["server failure", { status: 502 }, false],
  ["network timeout", {}, false],
])("handles a retry after %s without replaying an uncertain launch", async (_label, details, fresh) => {
  const endTime = Date.now() + 86400000;
  let posts = 0;
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      posts++;
      if (posts === 1) throw Object.assign(new Error("Launch refused"), details);
      return { status: fresh ? "active" : "already_requested" };
    }
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider" }] }
      : { campaign_binding_id: id, name: "Pilot", account_id: "42", funding_source: "provider", status: "PAUSED", snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, end_time: endTime, ads: [{ id: "8", status: "PAUSED" }] };
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
  await screen.findByText("Launch refused");
  fireEvent.click(screen.getByRole("button", { name: /Approve and launch/ }));
  await screen.findByText(fresh
    ? "LinkedIn Ads confirmed the campaign is active."
    : "Zavi is checking whether this launch went through… It may already be running: if it should not be, press Pause on it. Do not launch it again until this check finishes.");
  const requests = api.mock.calls.filter(([, opts]) => opts?.method === "POST")
    .map(([, opts]) => JSON.parse(String(opts.body)).request_id);
  expect(requests).toHaveLength(2);
  if (fresh) expect(requests[1]).not.toBe(requests[0]);
  else expect(requests[1]).toBe(requests[0]);
});

it.each([
  ["no budget was ever set", async () => ({ budget: null }), "Launching needs a Zavi monthly ad budget, and none is set.", "Set a monthly ad budget"],
  ["the budget was stopped", async () => ({ budget: { status: "stopped" } }), "Launching needs a Zavi monthly ad budget, and none is set.", "Set a monthly ad budget"],
  ["the budget read fails", async () => { throw Object.assign(new Error("Could not load the ad budget."), { status: 503 }); }, "Could not check your Zavi monthly ad budget, so launching is off for now.", "Try again"],
])("blocks a LinkedIn launch before it is sent when %s", async (_label, budgetReply, copy, linkText) => {
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: "active" };
    if (path === "/api/workspace/ad-budget") return budgetReply();
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider" }] }
      : { campaign_binding_id: id, name: "Pilot", account_id: "42", funding_source: "provider", status: "PAUSED", snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, end_time: Date.now() + 86400000, ads: [{ id: "8", status: "PAUSED" }] };
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain(copy);
  expect(alert.textContent).not.toMatch(/budget is set|budget exists/);
  const link = linkText === "Try again" ? screen.getByRole("button", { name: linkText }) : screen.getByRole("link", { name: linkText });
  if (linkText !== "Try again") {
    expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy#ad-budget");
    expect(link.getAttribute("target")).toBe("_blank");
  }
  expect(link.className).toContain("underline");
  fireEvent.click(approve);
  fireEvent.submit(approve.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(0);
});

it("shows no budget notice and sends exactly one launch when the monthly budget is active", async () => {
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: "active" };
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "wallet" }] }
      : { campaign_binding_id: id, name: "Pilot", account_id: "42", funding_source: "wallet", status: "PAUSED", snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, end_time: Date.now() + 86400000, ads: [{ id: "8", status: "PAUSED" }] };
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);
  expect(screen.queryByText(/monthly ad budget/)).toBeNull();
  fireEvent.click(approve);
  await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
});

describe("after the shared wallet permission is withdrawn", () => {
  const own = "10000000-0000-4000-8000-000000000002";
  const walletReview = { campaign_binding_id: id, name: "Pilot", account_id: "42", funding_source: "wallet", status: "PAUSED", snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, end_time: Date.now() + 86400000, ads: [{ id: "8", status: "PAUSED" }] };
  beforeEach(() => {
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: "active" };
      if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
      return path.includes("?platform=")
        ? { campaigns: [
            { id: own, provider_campaign_id: "111", funding_source: "provider", name: "Own billing" },
            { id, provider_campaign_id: "222", funding_source: "wallet", name: "Wallet paid" },
          ] }
        : walletReview;
    });
  });

  it("a wallet-paid row offers no Review launch and says why, while an own-billing row keeps it", async () => {
    render(<BoundAdsCampaigns platform="linkedin" walletOff />);
    const rows = await screen.findAllByRole("listitem");
    const [ownRow, walletRow] = rows;
    expect(within(ownRow).getByRole("button", { name: "Review launch" })).toBeTruthy();
    expect(within(walletRow).queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(within(walletRow).getByTestId("wallet-off-launch").textContent).toMatch(/shared wallet permission is withdrawn.*Authorize the shared wallet/);
    expect(within(walletRow).getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("a launch form already open when the permission is withdrawn names the problem and cannot send a launch", async () => {
    const view = render(<BoundAdsCampaigns platform="linkedin" />);
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Review launch" }));
    const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    view.rerender(<BoundAdsCampaigns platform="linkedin" walletOff />);
    expect(approve.disabled).toBe(true);
    expect(document.getElementById("launch-blocked")?.textContent).toMatch(/shared wallet permission is withdrawn/);
    fireEvent.submit(approve.closest("form")!);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(0);
  });
});

const launchSummary = () => Object.fromEntries(Array.from(document.querySelectorAll("#launch-pace > div")).map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));
it("says reserved funds remain only when the paused LinkedIn campaign is funded by the Zavi wallet", async () => {
  const own = "10000000-0000-4000-8000-000000000002";
  api.mockImplementation(async (path: string, opts?: RequestInit) =>
    opts?.method === "POST"
      ? { ok: true }
      : { campaigns: [
          { id: own, provider_campaign_id: "111", funding_source: "provider" },
          { id, provider_campaign_id: "222", funding_source: "wallet" },
        ] },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  const [ownPause, walletPause] = await screen.findAllByRole("button", { name: "Pause" });
  fireEvent.click(ownPause);
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${own}/pause`, { method: "POST", body: "{}" }));
  expect((await screen.findByRole("status")).textContent).toBe("LinkedIn confirmed the campaign is paused.");
  expect(screen.queryByText(/Reserved funds/)).toBeNull();
  fireEvent.click(walletPause);
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${id}/pause`, { method: "POST", body: "{}" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(
    "LinkedIn confirmed the campaign is paused. Reserved funds remain until final spending is settled.",
  ));
  expect(screen.queryAllByRole("button", { name: "Pause" })).toHaveLength(0);
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(2);
});

it("keeps a ChatGPT wallet pause on its own route with no LinkedIn notice", async () => {
  api.mockImplementation(async (path: string, opts?: RequestInit) =>
    opts?.method === "POST"
      ? { ok: true }
      : path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "wallet" }] }
        : { campaign: { id, name: "Wallet campaign", updated_at: 7 }, campaign_name_prefix: "", currency: "USD" },
  );
  render(<BoundAdsCampaigns platform="chatgpt" />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(`/api/ads/chatgpt/campaigns/${id}`, {
      method: "POST",
      body: JSON.stringify({ status: "paused", expected_updated_at: 7 }),
    }),
  );
  await waitFor(() => expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.mock.calls.some(([p]) => String(p).endsWith("/pause"))).toBe(false);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/LinkedIn|Reserved funds/)).toBeNull();
});

it("lists LinkedIn campaigns by the founder's name and pauses the row that was pressed", async () => {
  const first = "10000000-0000-4000-8000-000000000003";
  const second = "10000000-0000-4000-8000-000000000004";
  const long = `Spring hiring push for senior backend engineers in Bengaluru ${"x".repeat(120)}`;
  api.mockImplementation(async (path: string, opts?: RequestInit) =>
    opts?.method === "POST"
      ? { ok: true }
      : { campaigns: [
          { id: first, provider_campaign_id: "555001", funding_source: "provider", name: "Founder webinar signups" },
          { id: second, provider_campaign_id: "555002", funding_source: "wallet", name: long },
          { id, provider_campaign_id: "555003", funding_source: "provider", name: null },
        ] },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  const webinar = await screen.findByText("Founder webinar signups");
  const hiring = screen.getByText(long);
  expect(screen.getByText("Campaign 555003")).toBeTruthy();
  expect(screen.queryByText(/Campaign 555001|Campaign 555002/)).toBeNull();
  expect(hiring.className).toContain("truncate");
  expect(hiring.getAttribute("title")).toBe(long);
  expect(hiring.parentElement!.className).toContain("min-w-0");
  expect(screen.getAllByText("Paid from your Zavi shared wallet")).toHaveLength(1);
  expect(screen.getAllByText("Billed to your own LinkedIn Ads account")).toHaveLength(2);
  const row = (el: HTMLElement) => el.closest("[data-campaign-row]") as HTMLElement;
  expect(row(hiring).textContent).toContain("Paid from your Zavi shared wallet");
  expect(row(hiring).textContent).not.toContain("Billed to your own");
  expect(row(webinar).textContent).toContain("Billed to your own LinkedIn Ads account");
  expect(row(webinar).textContent).not.toContain("shared wallet");
  fireEvent.click(within(row(hiring)).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${second}/pause`, { method: "POST", body: "{}" }));
  await waitFor(() => expect((within(row(webinar)).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(within(row(webinar)).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${first}/pause`, { method: "POST", body: "{}" }));
  const pauses = api.mock.calls.filter(([, o]) => o?.method === "POST").map(([p]) => p);
  expect(pauses).toEqual([`/api/ads/campaigns/${second}/pause`, `/api/ads/campaigns/${first}/pause`]);
});

it.each([
  ["ended", "LinkedIn shows this campaign already ended, so there was nothing to pause."],
  ["already_paused", "LinkedIn shows this campaign was already paused."],
])("says a LinkedIn campaign answering %s was not paused now, and offers no second pause", async (answer, says) => {
  api.mockImplementation(async (_path: string, opts?: RequestInit) =>
    opts?.method === "POST"
      ? { status: answer }
      : { campaigns: [{ id, provider_campaign_id: "222", funding_source: "provider" }] },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  expect((await screen.findByTestId("row-notice")).textContent).toBe(says);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Pause" })).toBeNull());
  if (answer === "ended") {
    expect(screen.queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(screen.getByTestId("ended-row").textContent).toBe("This campaign has ended, so it cannot be launched or paused.");
  }
});

it.each([
  ["wallet", [{ id: "8", status: "PAUSED" }], "Paid from your shared wallet · 1 ad"],
  ["provider", [{ id: "8", status: "PAUSED" }, { id: "9", status: "PAUSED" }], "Billed to your LinkedIn Ads account (42) · 2 ads"],
])("reads the %s launch header in plain words with the right ad count", async (funding, ads, header) => {
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: "active" };
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "9876", funding_source: funding, name: "Spring launch" }] }
      : { campaign_binding_id: id, name: "Spring launch", account_id: "42", funding_source: funding, status: "PAUSED", snapshot: "a".repeat(64), currency: "EUR", fx: { units_per_usd: 0.8, as_of: "2026-10-13" }, total_budget_cents: null, end_time: null, ads };
  });
  const onCampaigns = vi.fn();
  render(<BoundAdsCampaigns platform="linkedin" onCampaigns={onCampaigns} />);
  await waitFor(() => expect(onCampaigns).toHaveBeenCalledWith([expect.objectContaining({ id, name: "Spring launch" })]));
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const form = (await screen.findByLabelText("Total campaign budget (EUR)")).closest("form")!;
  expect(within(form).getByText((_, el) => el?.tagName === "P" && el.textContent === header)).toBeTruthy();
  expect(form.textContent).not.toMatch(/\b1 ads\b|Account 42 ·/);
  if (funding === "wallet") expect(form.textContent).not.toMatch(/\b42\b/);
  expect(form.querySelector("[title]")).toBeNull();
  expect(form.textContent).toContain("approximately USD 0.00");
  expect(form.textContent).not.toContain("—");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(0);
});
it("offers no launch for a campaign still being set up and keeps launch for a finished one", async () => {
  const ready = "10000000-0000-4000-8000-000000000005";
  const unfinished = "10000000-0000-4000-8000-000000000006";
  const stuck = "10000000-0000-4000-8000-000000000008";
  api.mockImplementation(async (path: string, opts?: RequestInit) =>
    opts?.method === "POST"
      ? { ok: true }
      : path.includes("?platform=")
        ? { campaigns: [
            { id: ready, provider_campaign_id: "555101", funding_source: "provider", name: "Ready campaign" },
            { id: unfinished, provider_campaign_id: "555102", funding_source: "wallet", name: "Unfinished campaign", setting_up: "retry" },
            { id: stuck, provider_campaign_id: "555103", funding_source: "provider", name: "Stuck campaign", setting_up: "check" },
          ] }
        : path.endsWith("/launch")
          ? { campaign_binding_id: ready, name: "Ready campaign", account_id: "11", funding_source: "provider", status: "PAUSED", currency: "USD", snapshot: "a".repeat(64), total_budget_cents: null, end_time: null, ads: [{ id: "800", status: "PAUSED" }] }
          : { budget: { status: "active" } },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  const row = (el: HTMLElement) => el.closest("[data-campaign-row]") as HTMLElement;
  const half = row(await screen.findByText("Unfinished campaign"));
  expect(within(half).queryByRole("button", { name: "Review launch" })).toBeNull();
  expect(within(half).getByText("Still being set up. Press Try again on its campaign card to finish it before launching.")).toBeTruthy();
  expect(within(half).queryByText(/Campaign Manager/)).toBeNull();
  expect(within(half).getByRole("button", { name: "Pause" })).toBeTruthy();
  const check = row(screen.getByText("Stuck campaign"));
  expect(within(check).queryByRole("button", { name: "Review launch" })).toBeNull();
  expect(within(check).getByText("Zavi could not confirm this campaign finished setting up. Check it in LinkedIn Campaign Manager before launching.")).toBeTruthy();
  expect(within(check).queryByText(/Try again/)).toBeNull();
  expect(within(check).getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Review launch" })).toHaveLength(1);
  fireEvent.click(within(row(screen.getByText("Ready campaign"))).getByRole("button", { name: "Review launch" }));
  expect(await screen.findByText(/1 ad$/)).toBeTruthy();
  expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${ready}/launch`);
  expect(api.mock.calls.some(([p]) => String(p).includes(unfinished) || String(p).includes(stuck))).toBe(false);
});

const launchReview = (status: string, extra: Record<string, unknown> = {}) => ({
  campaign_binding_id: id, name: "Pilot", account_id: "42", funding_source: "provider", status, snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, observed_spend_cents: 0, end_time: Date.now() + 86400000, ads: [{ id: "8", status: "PAUSED" }], ...extra,
});
const linkedinApi = (status = "PAUSED", extra: Record<string, unknown> = {}) =>
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: path.endsWith("/pause") ? "paused" : "active" };
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    return path.includes("?platform=")
      ? { campaigns: [
          { id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" },
          { id: "10000000-0000-4000-8000-000000000007", provider_campaign_id: "12346", funding_source: "wallet", name: "Half built", setting_up: "retry" },
        ] }
      : launchReview(status, extra);
  });
const posts = () => api.mock.calls.filter(([, o]) => o?.method === "POST");

it.each(["member", "viewer", null])("gives a %s role no launch or pause control and sends nothing", async (role) => {
  viewer.role = role;
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText("Pilot");
  expect(screen.queryByRole("button", { name: "Review launch" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  expect(screen.getByText("Only workspace owners and admins can launch or pause campaigns.")).toBeTruthy();
  expect(screen.queryAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled)).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(0);
  expect(api.mock.calls.map(([p]) => p)).toEqual(["/api/ads/campaigns?platform=linkedin"]);
});

it.each(["owner", "admin"])("lets an %s review, launch and pause, and shows the confirmed status on the row", async (role) => {
  viewer.role = role;
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  const row = (await screen.findByText("Pilot")).closest("[data-campaign-row]") as HTMLElement;
  expect(screen.queryByText(/Only workspace owners and admins/)).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Review launch" }));
  fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
  await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
  expect(within(row).getByText("Live")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
  await screen.findByText("LinkedIn confirmed the campaign is paused.");
  expect(within(row).getByText("Paused")).toBeTruthy();
  expect(within(row).queryByText("Live")).toBeNull();
  expect(posts().map(([p]) => p)).toEqual([`/api/ads/campaigns/${id}/launch`, `/api/ads/campaigns/${id}/pause`]);
});

it("shows each campaign as its own card: name, billing line, status pill, and Review launch as the filled action with Pause as the quiet one", async () => {
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  const rows = await waitFor(() => {
    const found = Array.from(document.querySelectorAll("[data-campaign-row]")) as HTMLElement[];
    expect(found).toHaveLength(2);
    return found;
  });
  const [pilot, half] = rows;
  expect(pilot.tagName).toBe("LI");
  expect(pilot.className).toContain("rounded-xl");
  expect(pilot.className).toContain("border-ink/10");
  expect(pilot.className).toMatch(/(^| )flex-col( |$)/);
  expect(pilot.className).toContain("sm:flex-row");
  expect(within(pilot).getByText("Pilot").className).toContain("font-semibold");
  expect(within(pilot).getByText("Billed to your own LinkedIn Ads account").className).toContain("text-inkMuted");
  expect(within(half).getByText("Paid from your Zavi shared wallet")).toBeTruthy();
  expect(within(half).getByText("Setting up").className).toContain("rounded-full");
  expect(within(pilot).queryByText(/Setting up|Live|Paused/)).toBeNull();
  const review = within(pilot).getByRole("button", { name: "Review launch" });
  const pause = within(pilot).getByRole("button", { name: "Pause" });
  expect(review.className.split(" ")).toContain("bg-ink");
  expect(pause.className.split(" ")).not.toContain("bg-ink");
  for (const b of [review, pause]) {
    expect(b.className.split(" ")).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-9", "w-full", "sm:w-auto", "text-[13px]"]));
    expect(b.querySelector("svg")).not.toBeNull();
  }
  expect(pause.className.split(" ")).toContain("border");
  expect(review.parentElement).toBe(pause.parentElement);
  expect(pilot.textContent).not.toContain(" · ");
});

it("closes the launch form on Cancel without sending anything, and it can be reopened", async () => {
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const form = (await screen.findByRole("button", { name: /Approve and launch/ })).closest("form")!;
  const cancel = within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  expect(cancel.type).toBe("button");
  fireEvent.click(cancel);
  expect(screen.queryByRole("button", { name: /Approve and launch/ })).toBeNull();
  expect(screen.queryByLabelText("Total campaign budget (USD)")).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(0);
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
  expect(await screen.findByRole("button", { name: /Approve and launch/ })).toBeTruthy();
  expect(posts()).toHaveLength(0);
});

it.each([
  ["ACTIVE", {}, "This campaign is already running."],
  ["COMPLETED", {}, "This campaign has ended, so it cannot be launched again."],
  ["DRAFT", {}, "Only a paused campaign can be launched. Check it in LinkedIn Ads."],
  ["PAUSED", { total_budget_cents: null }, "Enter a total budget of at least $10.00 and an end date within the next year."],
  ["PAUSED", { total_budget_cents: null, currency: "EUR", fx: { units_per_usd: 0.8, as_of: "2026-10-13" } }, "Enter a total budget of at least €10.00 and an end date within the next year."],
])("says why Approve and launch is off for a %s campaign and sends nothing", async (status, extra, reason) => {
  linkedinApi(status, extra);
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.submit(approve.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(0);
  const why = screen.getByText(reason);
  expect(approve.getAttribute("aria-describedby")).toBe(why.id);
});

it("shows no reason line when Approve and launch is available", async () => {
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);
  expect(approve.getAttribute("aria-describedby")).toBeNull();
  expect(screen.queryByText(/already running|has ended|Only a paused|Enter a total budget/)).toBeNull();
});

it("holds an INR launch under $10 converted at the form, names the real minimum and sends nothing to the server", async () => {
  linkedinApi("PAUSED", { currency: "INR", fx: { units_per_usd: 83.12, as_of: "2026-10-13" }, total_budget_cents: 50000 });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.submit(approve.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(0);
  const why = screen.getByText("Enter a total budget of at least ₹831.20 (about $10.00) and an end date within the next year.");
  expect(approve.getAttribute("aria-describedby")).toBe(why.id);
  expect((screen.getByLabelText("Total campaign budget (INR)") as HTMLInputElement).min).toBe("831.2");
  fireEvent.change(screen.getByLabelText("Total campaign budget (INR)"), { target: { value: "831.20" } });
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0][1]!.body))).toMatchObject({ total_budget_cents: 83120, reviewed_units_per_usd: 83.12 });
});

it("gives every launch-form and row button a tap target of at least 44px", async () => {
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  await screen.findByRole("button", { name: /Approve and launch/ });
  for (const b of screen.getAllByRole("button")) expect(b.className.split(" ")).toContain("min-h-11");
});

it("gives the budget field and the end date and time pickers a 44px row with 16px text on a phone, and no native date input", async () => {
  linkedinApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const budget = await screen.findByLabelText("Total campaign budget (USD)");
  const day = screen.getByRole("button", { name: "End date" });
  const time = screen.getByRole("button", { name: "End time" });
  for (const field of [budget, day, time]) {
    const classes = field.className.split(" ");
    expect(classes).toContain("min-h-11");
    expect(classes.some((c) => c === "text-[16px]" || c === "text-base")).toBe(true);
    expect(classes.some((c) => /^(text-(xs|sm)|ml-\d+)$/.test(c))).toBe(false);
  }
  expect(budget.className.split(" ")).toContain("max-w-[240px]");
  expect(budget.closest("form")!.querySelector('input[type="datetime-local"], input[type="date"], input[type="time"]')).toBeNull();
});

const isoLocal = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${w} ${d} ${mon} ${y}`;
};

it("sets the end from the themed day and time pickers and sends that local time, refusing yesterday", async () => {
  linkedinApi("PAUSED", { end_time: null });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  const dayButton = screen.getByRole("button", { name: "End date" });
  expect(dayButton.textContent).toContain("Pick a day");
  fireEvent.click(dayButton);
  const dialog = screen.getByRole("dialog", { name: "Choose a day" });
  const yesterday = isoLocal(Date.now() - 86400000);
  const yesterdayButton = within(dialog).queryByRole("button", { name: dayLabel(yesterday) }) as HTMLButtonElement | null;
  if (yesterdayButton) expect(yesterdayButton.disabled).toBe(true);
  const target = new Date(Date.now() + 2 * 86400000);
  const targetDay = isoLocal(target.getTime());
  while (!within(screen.getByRole("dialog", { name: "Choose a day" })).queryByRole("button", { name: dayLabel(targetDay) }))
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a day" })).getByRole("button", { name: dayLabel(targetDay) }));
  expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
  expect(screen.getByRole("button", { name: "End date" }).textContent).toContain(dayLabel(targetDay));
  fireEvent.click(screen.getByRole("button", { name: "End time" }));
  fireEvent.click(screen.getByRole("option", { name: "9:30 AM" }));
  expect(screen.getByRole("button", { name: "End time" }).textContent).toContain("9:30 AM");
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(posts()).toHaveLength(1));
  const [y, m, d] = targetDay.split("-").map(Number);
  expect(JSON.parse(String(posts()[0][1]!.body)).end_time).toBe(new Date(y, m - 1, d, 9, 30).getTime());
});

it("shows the end the campaign already has in the pickers and keeps the date within a year", async () => {
  const at = new Date(Date.now() + 3 * 86400000);
  at.setHours(14, 15, 0, 0);
  linkedinApi("PAUSED", { end_time: at.getTime() });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  expect((await screen.findByRole("button", { name: "End date" })).textContent).toContain(dayLabel(isoLocal(at.getTime())));
  expect(screen.getByRole("button", { name: "End time" }).textContent).toContain("2:15 PM");
  fireEvent.click(screen.getByRole("button", { name: "End date" }));
  for (let i = 0; i < 14; i++) {
    const next = screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement;
    if (next.disabled) break;
    fireEvent.click(next);
  }
  expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
  const tooFar = isoLocal(Date.now() + 367 * 86400000);
  const far = within(screen.getByRole("dialog", { name: "Choose a day" })).queryByRole("button", { name: dayLabel(tooFar) }) as HTMLButtonElement | null;
  if (far) expect(far.disabled).toBe(true);
});

const budgetApi = (budget: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: "active" };
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active", ...budget } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" }] }
      : launchReview("PAUSED", extra);
  });

it("says a prorated monthly ad budget cannot hold the launch, with what is left and a link to raise it", async () => {
  budgetApi({ monthly_usd: 10, month_cap_usd: 0.64, held_usd: 0, left_usd: 0.64, days_left: 2 });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  await screen.findByRole("button", { name: /Approve and launch/ });
  const month = new Date().toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$0\.64 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain(`(it started part-way through ${month})`);
  expect(hint.textContent).toContain("This $100.00 launch does not fit the $0.64 left this month in your monthly ad budget");
  expect(hint.textContent).toContain("A launch needs at least $10.00, so raise your monthly ad budget to launch.");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  const link = within(hint).getByRole("link", { name: "Open your monthly ad budget" });
  expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy#ad-budget");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("names the largest total that fits the money left, converts a non-USD total, and drops the hint once the total fits", async () => {
  budgetApi(
    { monthly_usd: 300, month_cap_usd: 300, held_usd: 250, left_usd: 40 },
    { currency: "EUR", fx: { units_per_usd: 0.8, as_of: "2026-10-13" }, total_budget_cents: 3200 },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (EUR)");
  expect(screen.queryByText(/left this month/)).toBeNull();
  fireEvent.change(input, { target: { value: "32.01" } });
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$40\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("This €32.01 launch does not fit the $40.00 left this month");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(hint.textContent).not.toContain("part-way");
  expect(hint.textContent).toContain("lower the total to €32.00 (about $40.00) or less");
  fireEvent.change(input, { target: { value: "32" } });
  expect(screen.queryByText(/left this month/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Approve and launch/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
});

it("measures the month hint against what is left to spend after the campaign's reported spend, not the full total", async () => {
  budgetApi({ monthly_usd: 300, month_cap_usd: 300, held_usd: 260, left_usd: 40 }, { observed_spend_cents: 7000 });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (USD)");
  expect(screen.queryByText(/left this month/)).toBeNull();
  fireEvent.change(input, { target: { value: "110" } });
  expect(screen.queryByText(/left this month/)).toBeNull();
  fireEvent.change(input, { target: { value: "110.01" } });
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$40\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("The $40.01 still to spend on this $110.01 launch ($70.00 already spent) does not fit the $40.00 left this month");
  expect(hint.textContent).toContain("lower the total to $110.00 or less");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "100" } });
  expect(screen.queryByText(/left this month/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Approve and launch/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0]![1]!.body)).total_budget_cents).toBe(10000);
});

it("credits a paused campaign's own $10 hold on relaunch, so a $10 relaunch of a month whose only hold is its own fits", async () => {
  budgetApi({ monthly_usd: 155, month_cap_usd: 10, held_usd: 10, left_usd: 0 }, { total_budget_cents: 1000, observed_spend_cents: 0, own_hold_usd: 10 });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (USD)");
  expect((input as HTMLInputElement).value).toBe("10");
  expect(screen.queryByText(/left this month/)).toBeNull();
  expect(screen.queryByText(/does not fit/)).toBeNull();
  fireEvent.change(input, { target: { value: "10.01" } });
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$10\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("counting the $10.00 already set aside for this campaign");
  expect(hint.textContent).toContain("This $10.01 launch does not fit");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(hint.textContent).toContain("lower the total to $10.00 or less");
  fireEvent.change(input, { target: { value: "10" } });
  expect(screen.queryByText(/left this month/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Approve and launch/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0]![1]!.body)).total_budget_cents).toBe(1000);
});

it.each([
  ["an own hold too small to cover the launch", 4, "$4.00", "counting the $4.00 already set aside"],
  ["an own hold that could not be read", null, "$0.00", null],
  ["no own hold", 0, "$0.00", null],
])("still says a relaunch does not fit with %s", async (_label, own, left, counting) => {
  budgetApi({ monthly_usd: 155, month_cap_usd: 10, held_usd: 10, left_usd: 0 }, { total_budget_cents: 1000, observed_spend_cents: 0, own_hold_usd: own });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && el.textContent?.includes(`the ${left} left this month`) === true);
  expect(hint.textContent).toContain("This $10.00 launch does not fit");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(hint.textContent).toContain("A launch needs at least $10.00, so raise your monthly ad budget to launch.");
  if (counting) expect(hint.textContent).toContain(counting);
  else expect(hint.textContent).not.toContain("already set aside");
});

it("asks to raise the monthly budget, not to lower the total to what was already spent, when nothing is left this month", async () => {
  budgetApi({ monthly_usd: 300, month_cap_usd: 300, held_usd: 300, left_usd: 0 }, { observed_spend_cents: 7000 });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$0\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("raise your monthly ad budget to launch");
  expect(hint.textContent).not.toContain("lower the total");
});

it("says a launch may not fit when the campaign's reported spend could not be read, and keeps Approve available", async () => {
  budgetApi({ monthly_usd: 300, month_cap_usd: 300, held_usd: 260, left_usd: 40 }, { observed_spend_cents: null });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /has \$40\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("this $100.00 launch may not fit");
  expect(hint.textContent).not.toContain("will not fit");
  expect(hint.textContent).not.toContain("does not fit");
  expect(hint.textContent).toContain("lower the total to $40.00 or less");
  const approve = screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(posts()).toHaveLength(1));
});

it("keeps the typed total and end date when the founder sets a budget in a new tab, and Approve and the month text follow the fresh read on return", async () => {
  let budget: unknown = { budget: null };
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: "active" };
    if (path === "/api/workspace/ad-budget") return budget;
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" }] }
      : launchReview("PAUSED");
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = (await screen.findByLabelText("Total campaign budget (USD)")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "50" } });
  const targetDay = isoLocal(Date.now() + 3 * 86400000);
  fireEvent.click(screen.getByRole("button", { name: "End date" }));
  while (!within(screen.getByRole("dialog", { name: "Choose a day" })).queryByRole("button", { name: dayLabel(targetDay) }))
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a day" })).getByRole("button", { name: dayLabel(targetDay) }));
  fireEvent.click(screen.getByRole("button", { name: "End time" }));
  fireEvent.click(screen.getByRole("option", { name: "9:30 AM" }));
  const link = screen.getByRole("link", { name: "Set a monthly ad budget" });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy#ad-budget");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  const reads = () => api.mock.calls.filter(([p]) => p === "/api/workspace/ad-budget").length;
  const before = reads();
  budget = { budget: { status: "active", monthly_usd: 300, month_cap_usd: 300, left_usd: 60 } };
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(screen.queryByText(/none is set/)).toBeNull());
  expect(reads()).toBe(before + 1);
  expect(input.value).toBe("50");
  expect(screen.getByLabelText("Total campaign budget (USD)")).toBe(input);
  expect(screen.getByRole("button", { name: "End date" }).textContent).toContain(dayLabel(targetDay));
  expect(screen.getByRole("button", { name: "End time" }).textContent).toContain("9:30 AM");
  expect(document.getElementById("launch-over-month")).toBeNull();
  const approve = screen.getByRole("button", { name: "Approve and launch · $50.00 total" }) as HTMLButtonElement;
  await waitFor(() => expect(approve.disabled).toBe(false));
  fireEvent.change(input, { target: { value: "100" } });
  await waitFor(() => expect(document.getElementById("launch-over-month")?.textContent).toContain("does not fit the $60.00 left"));
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  budget = { budget: { status: "active", monthly_usd: 500, month_cap_usd: 500, left_usd: 200 } };
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(document.getElementById("launch-over-month")).toBeNull());
  expect((screen.getByRole("button", { name: "Approve and launch · $100.00 total" }) as HTMLButtonElement).disabled).toBe(false);
  budget = { budget: { status: "active", monthly_usd: 500, month_cap_usd: 500, left_usd: 20 } };
  act(() => {
    window.dispatchEvent(new Event("zavi:ad-budget-changed"));
  });
  await waitFor(() => expect(document.getElementById("launch-over-month")?.textContent).toContain("does not fit the $20.00 left"));
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(input.value).toBe("100");
  expect(posts()).toHaveLength(0);
  fireEvent.change(input, { target: { value: "20" } });
  const go = screen.getByRole("button", { name: "Approve and launch · $20.00 total" }) as HTMLButtonElement;
  await waitFor(() => expect(go.disabled).toBe(false));
  fireEvent.click(go);
  await waitFor(() => expect(posts()).toHaveLength(1));
  const sent = JSON.parse(String(posts()[0][1].body));
  const [y, mo, d] = targetDay.split("-").map(Number);
  expect(sent.total_budget_cents).toBe(2000);
  expect(sent.end_time).toBe(new Date(y, mo - 1, d, 9, 30).getTime());
  Reflect.deleteProperty(document, "visibilityState");
});

it("offers Try again when the monthly budget read fails, and a stale answer that lands after a fresher one never wins", async () => {
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  let fail = true;
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: "active" };
    if (path === "/api/workspace/ad-budget") {
      if (fail) throw Object.assign(new Error("Could not load the ad budget."), { status: 503 });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" }] }
      : launchReview("PAUSED");
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  await screen.findByText(/Could not check your Zavi monthly ad budget/);
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => {
    window.dispatchEvent(new Event("zavi:ad-budget-changed"));
  });
  expect(pending).toHaveLength(2);
  await act(async () => {
    pending[1].resolve({ budget: { status: "active", monthly_usd: 300, month_cap_usd: 300, left_usd: 300 } });
  });
  const approve = await screen.findByRole("button", { name: "Approve and launch · $100.00 total" }) as HTMLButtonElement;
  await waitFor(() => expect(approve.disabled).toBe(false));
  await act(async () => {
    pending[0].resolve({ budget: null });
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText(/none is set/)).toBeNull();
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(posts()).toHaveLength(1));
});

const qaMonth = { monthly_usd: 155, month_cap_usd: 155, held_usd: 155, left_usd: 0 };
const REFUSED = "This launch would go over your monthly ad budget. Nothing was sent to LinkedIn. Lower the total budget or raise your monthly ad budget, then try again.";

it("refuses a $50 relaunch when only $10 is left counting its own hold: Approve is off, the refusal says so, and nothing is sent", async () => {
  budgetApi(qaMonth, { total_budget_cents: 1000, observed_spend_cents: 0, own_hold_usd: 10 });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (USD)");
  fireEvent.change(input, { target: { value: "50" } });
  const approve = screen.getByRole("button", { name: "Approve and launch · $50.00 total" }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  const box = document.getElementById("launch-over-month")!;
  expect(box.textContent).toBe(
    "This $50.00 launch does not fit the $10.00 left this month in your monthly ad budget, counting the $10.00 already set aside for this campaign, so it cannot be approved. Raise your monthly ad budget, or lower the total to $10.00 or less. Open your monthly ad budget",
  );
  expect(box.textContent).not.toContain("may not fit");
  expect(within(box).getByRole("link", { name: "Open your monthly ad budget" }).getAttribute("href")).toBe("/workspace?tab=growth-strategy#ad-budget");
  expect(approve.getAttribute("aria-describedby")).toBe("launch-over-month");
  fireEvent.click(approve);
  fireEvent.submit(approve.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(0);
  fireEvent.change(input, { target: { value: "10" } });
  expect(document.getElementById("launch-over-month")).toBeNull();
  const ok = screen.getByRole("button", { name: "Approve and launch · $10.00 total" }) as HTMLButtonElement;
  expect(ok.disabled).toBe(false);
  fireEvent.click(ok);
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0]![1]!.body)).total_budget_cents).toBe(1000);
});

it("measures the month by the full total LinkedIn enforces, not the daily pace: a $50 total at $5 a day ending tomorrow does not fit $10 left", async () => {
  budgetApi(qaMonth, {
    total_budget_cents: 1000,
    observed_spend_cents: 0,
    own_hold_usd: 10,
    daily_budget_cents: 500,
    start_time: Date.now() - 86400000,
    end_time: Date.now() + 86400000 - 1800000,
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (USD)");
  fireEvent.change(input, { target: { value: "50" } });
  expect(launchSummary()).toMatchObject({ "Daily limit": "$5.00 a day", Total: "$50.00, then it stops", "Set aside": "$50.00 from your monthly ad budget" });
  expect(document.getElementById("launch-over-month")!.textContent).toContain("This $50.00 launch does not fit the $10.00 left this month");
  const approve = screen.getByRole("button", { name: "Approve and launch · $50.00 total" }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(approve);
  fireEvent.submit(approve.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(0);
  fireEvent.change(input, { target: { value: "10" } });
  expect(document.getElementById("launch-over-month")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve and launch · $10.00 total" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0]![1]!.body)).total_budget_cents).toBe(1000);
});

it.each([
  [110, true],
  [999.99, true],
  [1000, false],
])("a $1000 total at $10 a day for 10 days needs the whole $1000: with $%s left Approve is off = %s", async (left, off) => {
  budgetApi(
    { monthly_usd: 1000, month_cap_usd: 1000, held_usd: 1000 - left, left_usd: left },
    { total_budget_cents: 100000, daily_budget_cents: 1000, start_time: Date.now() - 86400000, end_time: Date.now() + 9 * 86400000 - 1800000 },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: "Approve and launch · $1,000.00 total" })) as HTMLButtonElement;
  expect(launchSummary()).toMatchObject({ "Daily limit": "$10.00 a day", Total: "$1,000.00, then it stops", "Set aside": "$1,000.00 from your monthly ad budget" });
  expect(approve.disabled).toBe(off);
  expect(document.getElementById("launch-over-month") === null).toBe(!off);
  fireEvent.click(approve);
  fireEvent.submit(approve.closest("form")!);
  await new Promise((r) => setTimeout(r, 20));
  expect(posts()).toHaveLength(off ? 0 : 1);
  if (!off) expect(JSON.parse(String(posts()[0]![1]!.body)).total_budget_cents).toBe(100000);
});

it("keeps Approve on when the campaign's spend could not be read, says the launch may not fit, and shows the server's refusal", async () => {
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") throw new Error(REFUSED);
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active", ...qaMonth } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" }] }
      : launchReview("PAUSED", { total_budget_cents: 1000, observed_spend_cents: null, own_hold_usd: 10 });
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (USD)");
  fireEvent.change(input, { target: { value: "50" } });
  const box = document.getElementById("launch-over-month")!;
  expect(box.textContent).toContain("so this $50.00 launch may not fit.");
  expect(box.textContent).not.toContain("does not fit");
  const approve = screen.getByRole("button", { name: "Approve and launch · $50.00 total" }) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(await screen.findByText(REFUSED)).toBeTruthy();
});

it("never suggests a non-USD total below the launch minimum, and asks to raise the monthly budget instead", async () => {
  budgetApi(
    { monthly_usd: 300, month_cap_usd: 300, held_usd: 290, left_usd: 10 },
    { currency: "INR", fx: { units_per_usd: 83.1237, as_of: "2026-10-13" }, total_budget_cents: 100000 },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$10\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("A launch needs at least ₹831.24 (about $10.00), so raise your monthly ad budget to launch.");
  expect(hint.textContent).not.toContain("lower the total");
});

it("clears a failed list re-read once a later re-read succeeds, but keeps a launch error", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let reads = 0;
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/pause")) throw new Error("LinkedIn did not confirm the pause.");
      if (!path.includes("?platform=")) return { budget: { status: "active" } };
      reads += 1;
      if (reads === 2) throw new Error("Campaigns could not be loaded.");
      return { campaigns: [{ id, provider_campaign_id: "777", funding_source: "provider", name: "Half built", setting_up: "check" }] };
    });
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText(/could not confirm this campaign finished setting up/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect((await screen.findByRole("alert")).textContent).toBe("Campaigns could not be loaded.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(reads).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect((await screen.findByRole("alert")).textContent).toBe("LinkedIn did not confirm the pause.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(4);
    expect(screen.getByRole("alert").textContent).toBe("LinkedIn did not confirm the pause.");
  } finally {
    vi.useRealTimers();
  }
});

it("re-reads the campaign list on its own while one is still being set up, so a finished Try again shows Review launch with no reload", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let finished = false;
    api.mockImplementation(async (path: string) =>
      path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "777", funding_source: "provider", name: "Half built", ...(finished ? {} : { setting_up: "check" }) }] }
        : { budget: { status: "active" } },
    );
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText(/could not confirm this campaign finished setting up/);
    expect(screen.queryByRole("button", { name: "Review launch" })).toBeNull();
    finished = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(await screen.findByRole("button", { name: "Review launch" })).toBeTruthy();
    expect(screen.queryByText(/could not confirm/)).toBeNull();
    const reads = api.mock.calls.filter(([p]) => p === "/api/ads/campaigns?platform=linkedin").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.mock.calls.filter(([p]) => p === "/api/ads/campaigns?platform=linkedin").length).toBe(reads);
  } finally {
    vi.useRealTimers();
  }
});

it("drops the still-being-set-up line and offers Review launch once Try again on the campaign card finishes, with no reload", async () => {
  const half = "10000000-0000-4000-8000-000000000009";
  const card = makeAction("image_post", { id: "ca-try", channel_slug: "linkedin_ads", exec_status: "failed" } as never);
  const server = { exec: "failed" as "failed" | "queued" | "succeeded" };
  const respond = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST" && u === "/api/channel-actions/ca-try/approve") {
      server.exec = "queued";
      return respond({ ok: true });
    }
    if (u.includes("/history")) return respond({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/metrics")) return respond({ metrics: [] });
    if (u.startsWith("/api/channels/linkedin_ads/actions"))
      return respond({ actions: server.exec === "succeeded" ? [] : [{ ...card, exec_status: server.exec }], more: 0, store: "channel_actions", plan: null });
    return Promise.reject(new Error(`unexpected ${u}`));
  });
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") throw new Error("no write expected");
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    if (path.includes("?platform="))
      return { campaigns: [{ id: half, provider_campaign_id: "777", funding_source: "wallet", name: "Half built", ...(server.exec === "succeeded" ? {} : { setting_up: server.exec === "failed" ? "retry" : "check" }) }] };
    return { campaign_binding_id: half, name: "Half built", account_id: "42", funding_source: "wallet", status: "PAUSED", currency: "USD", snapshot: "a".repeat(64), total_budget_cents: 10000, end_time: Date.now() + 86400000, ads: [{ id: "8", status: "PAUSED" }] };
  });
  const listReads = () => api.mock.calls.filter(([p]) => p === "/api/ads/campaigns?platform=linkedin").length;
  const rowOf = () => (screen.getByText("Half built").closest("[data-campaign-row]") as HTMLElement);

  render(<BoundAdsCampaigns platform="linkedin" />);
  const { result } = renderHook(() => useChannelActions("linkedin_ads"));
  await screen.findByText("Still being set up. Press Try again on its campaign card to finish it before launching.");
  await waitFor(() => expect(result.current.actions.map((a) => a.exec_status)).toEqual(["failed"]));
  expect(within(rowOf()).queryByRole("button", { name: "Review launch" })).toBeNull();
  expect(listReads()).toBe(1);

  await act(async () => {
    announceChannelHistoryChanged("chatgpt_ads");
  });
  expect(listReads()).toBe(1);

  let approved: boolean | undefined;
  await act(async () => {
    approved = (await result.current.handlers.onApprove!(card as never)) as boolean | undefined;
  });
  expect(approved).toBe(true);
  await waitFor(() => expect(result.current.actions.map((a) => a.exec_status)).toEqual(["queued"]));
  await waitFor(() => expect(listReads()).toBeGreaterThanOrEqual(2));
  expect(await within(rowOf()).findByText("Zavi could not confirm this campaign finished setting up. Check it in LinkedIn Campaign Manager before launching.")).toBeTruthy();
  expect(within(rowOf()).queryByRole("button", { name: "Review launch" })).toBeNull();
  const afterApprove = listReads();

  server.exec = "succeeded";
  await act(async () => {
    await result.current.refreshSilent();
  });
  await waitFor(() => expect(result.current.actions).toHaveLength(0));
  await waitFor(() => expect(listReads()).toBe(afterApprove + 1));
  const launch = await within(rowOf()).findByRole("button", { name: "Review launch" });
  expect(within(rowOf()).queryByText(/Still being set up|could not confirm/)).toBeNull();
  fireEvent.click(launch);
  expect(await screen.findByRole("button", { name: /Approve and launch/ })).toBeTruthy();
  expect(api).toHaveBeenCalledWith(`/api/ads/campaigns/${half}/launch`);
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(0);
  expect(apiFetch.mock.calls.filter(([, o]) => o?.method === "POST").map(([p]) => p)).toEqual(["/api/channel-actions/ca-try/approve"]);
});

it("keeps the newest list when an older refetch answers last", async () => {
  const half = "10000000-0000-4000-8000-000000000010";
  const gates: Array<(v: unknown) => void> = [];
  let reads = 0;
  api.mockImplementation((path: string) => {
    if (!path.includes("?platform=")) return Promise.resolve({ budget: { status: "active" } });
    reads += 1;
    if (reads === 1)
      return Promise.resolve({ campaigns: [{ id: half, provider_campaign_id: "778", funding_source: "wallet", name: "Racing", setting_up: "retry" }] });
    return new Promise((r) => gates.push(r));
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText(/Still being set up/);
  await act(async () => {
    announceChannelHistoryChanged("linkedin_ads");
  });
  await act(async () => {
    announceChannelHistoryChanged("linkedin_ads");
  });
  expect(gates).toHaveLength(2);
  await act(async () => {
    gates[1]({ campaigns: [{ id: half, provider_campaign_id: "778", funding_source: "wallet", name: "Racing" }] });
  });
  await act(async () => {
    gates[0]({ campaigns: [{ id: half, provider_campaign_id: "778", funding_source: "wallet", name: "Racing", setting_up: "retry" }] });
  });
  const row = screen.getByText("Racing").closest("[data-campaign-row]") as HTMLElement;
  expect(within(row).getByRole("button", { name: "Review launch" })).toBeTruthy();
  expect(within(row).queryByText(/Still being set up/)).toBeNull();
});

it("a $100 total at $10 a day over 3 days is measured by the whole $100 and does not fit $40 left", async () => {
  budgetApi(
    { monthly_usd: 300, month_cap_usd: 300, held_usd: 260, left_usd: 40 },
    { daily_budget_cents: 1000, start_time: Date.now() - 86400000, end_time: Date.now() + 2 * 86400000 - 1800000 },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const approve = (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
  const pace = await screen.findByText((_, el) => el?.id === "launch-pace");
  expect(launchSummary()).toMatchObject({ "Daily limit": "$10.00 a day", Total: "$100.00, then it stops", "Set aside": "$100.00 from your monthly ad budget" });
  expect(pace.textContent).not.toMatch(/only|at most|\$30/);
  expect(document.getElementById("launch-over-month")!.textContent).toContain("This $100.00 launch does not fit the $40.00 left this month");
  expect(approve.disabled).toBe(true);
});

it("a daily budget that can spend the whole total says LinkedIn stops at the total and keeps the full total for the month check", async () => {
  budgetApi(
    { monthly_usd: 300, month_cap_usd: 300, held_usd: 260, left_usd: 40 },
    { daily_budget_cents: 5000, start_time: Date.now() - 86400000, end_time: Date.now() + 2 * 86400000 - 1800000 },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const pace = await screen.findByText((_, el) => el?.id === "launch-pace");
  expect(launchSummary()).toMatchObject({ "Daily limit": "$50.00 a day", Total: "$100.00, then it stops", "Set aside": "$100.00 from your monthly ad budget" });
  const hint = await screen.findByText((_, el) => el?.tagName === "P" && /the \$40\.00 left this month/.test(el.textContent ?? ""));
  expect(hint.textContent).toContain("This $100.00 launch does not fit the $40.00 left this month");
});

it("takes a $10 total, the smallest LinkedIn accepts, and names $10 as the minimum below it", async () => {
  budgetApi({ monthly_usd: 300, month_cap_usd: 300, held_usd: 0, left_usd: 300 }, { daily_budget_cents: null });
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  const input = await screen.findByLabelText("Total campaign budget (USD)");
  fireEvent.change(input, { target: { value: "9.99" } });
  expect(screen.getByText("Enter a total budget of at least $10.00 and an end date within the next year.")).toBeTruthy();
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /Approve and launch/ }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0]![1]!.body)).total_budget_cents).toBe(1000);
});

it("the ENDED status the campaign list sends for a passed end date reads Ended and still offers Pause, since a stored end date can be stale", async () => {
  api.mockImplementation(async (path: string) =>
    path.includes("?platform=")
      ? { campaigns: [{ id: "a5", provider_campaign_id: "5", funding_source: "wallet", name: "Past end date", status: "ENDED" }] }
      : {},
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  const row = (await screen.findByText("Past end date")).closest("[data-campaign-row]") as HTMLElement;
  expect(within(row).getByText("Ended")).toBeTruthy();
  expect(within(row).queryByText("Live")).toBeNull();
  expect(within(row).getByRole("button", { name: "Pause" })).toBeTruthy();
});

it.each([
  ["ended", "Ended", "LinkedIn shows this campaign already ended, so there was nothing to pause."],
  ["paused", "Paused", null],
])("pressing Pause on a row stored as ENDED posts that campaign and answers %s", async (answer, pill, says) => {
  api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === "POST") return { status: answer };
    return path.includes("?platform=")
      ? { campaigns: [
          { id: "a5", provider_campaign_id: "5", funding_source: "provider", name: "Past end date", status: "ENDED" },
          { id: "a6", provider_campaign_id: "6", funding_source: "provider", name: "Other", status: "ACTIVE" },
        ] }
      : {};
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  const row = (await screen.findByText("Past end date")).closest("[data-campaign-row]") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/campaigns/a5/pause", { method: "POST", body: "{}" }));
  const status = await screen.findByRole("status");
  if (says) expect(status.textContent).toBe(says);
  else expect(status.textContent).toMatch(/pause/i);
  await waitFor(() => expect(within(row).getByText(pill)).toBeTruthy());
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
});

it("a ChatGPT row stored as ended keeps no Pause, because its pause has no already-ended answer, while a live ChatGPT row keeps it", async () => {
  api.mockImplementation(async (path: string) =>
    path.includes("?platform=")
      ? { campaigns: [
          { id: "g1", provider_campaign_id: "1", funding_source: "wallet", name: "Finished one", status: "ENDED" },
          { id: "g2", provider_campaign_id: "2", funding_source: "wallet", name: "Live one", status: "ACTIVE" },
        ] }
      : {},
  );
  render(<BoundAdsCampaigns platform="chatgpt" />);
  const row = (name: string) => screen.getByText(name).closest("[data-campaign-row]") as HTMLElement;
  await screen.findByText("Finished one");
  expect(within(row("Finished one")).getByText("Ended")).toBeTruthy();
  expect(within(row("Finished one")).queryByRole("button", { name: "Pause" })).toBeNull();
  expect(within(row("Live one")).getByRole("button", { name: "Pause" })).toBeTruthy();
});

it("shows each listed campaign's status without a button press and keeps Pause on every row until LinkedIn itself says paused", async () => {
  api.mockImplementation(async (path: string) =>
    path.includes("?platform=")
      ? { campaigns: [
          { id: "a1", provider_campaign_id: "1", funding_source: "provider", name: "Paused one", status: "PAUSED" },
          { id: "a2", provider_campaign_id: "2", funding_source: "provider", name: "Running one", status: "ACTIVE" },
          { id: "a3", provider_campaign_id: "3", funding_source: "wallet", name: "Done one", status: "COMPLETED" },
          { id: "a4", provider_campaign_id: "4", funding_source: "wallet", name: "Unknown one" },
        ] }
      : {},
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  const row = (name: string) => screen.getByText(name).closest("[data-campaign-row]") as HTMLElement;
  await screen.findByText("Paused one");
  expect(within(row("Paused one")).getByText("Paused")).toBeTruthy();
  expect(within(row("Paused one")).getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(within(row("Paused one")).getByRole("button", { name: "Review launch" })).toBeTruthy();
  expect(within(row("Running one")).getByText("Active")).toBeTruthy();
  expect(within(row("Running one")).queryByText("Live")).toBeNull();
  expect(within(row("Running one")).getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(within(row("Done one")).getByText("Ended")).toBeTruthy();
  expect(within(row("Done one")).getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(within(row("Unknown one")).queryByText(/Paused|Live|Ended/)).toBeNull();
  expect(within(row("Unknown one")).getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(0);
});

const SERVER_TOO_SOON = "This launch would stop Oct 30, 2026, 18:00 UTC, less than 12 hours from now. Nothing was sent to LinkedIn and your campaign stays paused. Ask Zavi for a new end date, then approve the new card.";
const openForm = async (extra: Record<string, unknown>) => {
  linkedinApi("PAUSED", extra);
  render(<BoundAdsCampaigns platform="linkedin" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
  return (await screen.findByRole("button", { name: /Approve and launch/ })) as HTMLButtonElement;
};
const morning = () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 30, 8, 0, 0));
};

it("refuses a same-day end under 12 hours in the form, right under the pickers, and sends nothing", async () => {
  morning();
  const approve = await openForm({ end_time: new Date(2026, 9, 30, 14, 0).getTime() });
  expect(approve.disabled).toBe(true);
  const problem = document.getElementById("launch-end-problem")!;
  expect(problem.getAttribute("role")).toBe("alert");
  expect(problem.textContent).toContain("A launch has to run for at least 12 hours.");
  expect(problem.textContent).toContain("Oct 30, 8:01 PM");
  expect(problem.textContent).not.toMatch(/Ask Zavi|new card|within the next year/);
  expect(screen.getByRole("group", { name: /End date and time/ }).contains(problem)).toBe(true);
  expect(approve.getAttribute("aria-describedby")).toBe("launch-end-problem");
  expect(screen.queryByText(/Enter a total budget/)).toBeNull();
  fireEvent.submit(approve.closest("form")!);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "End time" }));
  fireEvent.click(screen.getByRole("option", { name: "11:30 PM" }));
  expect(document.getElementById("launch-end-problem")).toBeNull();
  expect(approve.disabled).toBe(false);
});

it.each([
  ["a minute short of the server's 12 hours once the send has reached it", 12 * 3600_000 + 30_000, true],
  ["non-regression guard, clear of the 12 hours and the slack", 12 * 3600_000 + 120_000, false],
])("holds the 12 hour line at the edge: %s", async (_label, ahead, refused) => {
  morning();
  const approve = await openForm({ end_time: Date.now() + ahead });
  expect(approve.disabled).toBe(refused);
  fireEvent.submit(approve.closest("form")!);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(posts()).toHaveLength(refused ? 0 : 1);
});

it("offers no day that cannot hold 12 hours: after noon today's date is off in the picker, tomorrow is on", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 30, 15, 0, 0));
  await openForm({ end_time: null });
  fireEvent.click(screen.getByRole("button", { name: "End date" }));
  const dialog = screen.getByRole("dialog", { name: "Choose a day" });
  expect((within(dialog).getByRole("button", { name: dayLabel("2026-10-30") }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: dayLabel("2026-10-31") }) as HTMLButtonElement).disabled).toBe(false);
});

it("a form left open past the 12 hour line stays Approve-clickable but sends nothing and says why", async () => {
  morning();
  const approve = await openForm({ end_time: Date.now() + 12 * 3600_000 + 5 * 60_000 });
  expect(approve.disabled).toBe(false);
  vi.setSystemTime(Date.now() + 10 * 60_000);
  fireEvent.click(approve);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(posts()).toHaveLength(0);
  expect(document.getElementById("launch-end-problem")!.textContent).toContain("A launch has to run for at least 12 hours.");
  expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
});

it("a server end-date refusal the form could not foresee drops the card instructions and shows beside Approve, scrolled into view", async () => {
  const scroll = vi.fn();
  const native = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const approve = await openForm({});
    api.mockImplementation(async (_p: string, opts?: RequestInit) => {
      if (opts?.method === "POST") throw new Error(SERVER_TOO_SOON);
      return {};
    });
    fireEvent.click(approve);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const form = approve.closest("form")!;
    const shown = await within(form).findByRole("alert");
    expect(shown.textContent).toContain("A launch has to run for at least 12 hours.");
    expect(document.body.textContent).not.toMatch(/Ask Zavi for a new end date|approve the new card/);
    expect(scroll).toHaveBeenCalled();
    expect(form.contains(scroll.mock.instances[0] as unknown as Node)).toBe(true);
  } finally {
    Element.prototype.scrollIntoView = native;
  }
});

it("any other launch refusal also lands inside the form, not above the campaign list where the founder is not looking", async () => {
  const approve = await openForm({});
  api.mockImplementation(async (_p: string, opts?: RequestInit) => {
    if (opts?.method === "POST") throw new Error("This launch would go over your monthly ad budget.");
    return {};
  });
  fireEvent.click(approve);
  const form = approve.closest("form")!;
  expect((await within(form).findByRole("alert")).textContent).toBe("This launch would go over your monthly ad budget.");
  expect(screen.getAllByText("This launch would go over your monthly ad budget.")).toHaveLength(1);
});

it("non-regression guard: a Pause failure with the form open stays above the list and does not read as a launch refusal", async () => {
  const approve = await openForm({});
  const form = approve.closest("form")!;
  api.mockImplementation(async (_p: string, opts?: RequestInit) => {
    if (opts?.method === "POST") throw new Error("LinkedIn did not answer the pause.");
    return {};
  });
  const row = document.querySelector("[data-campaign-row]") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
  const alert = await screen.findByText("LinkedIn did not answer the pause.");
  expect(form.contains(alert)).toBe(false);
});

it("an end before the campaign's start date is refused in the form, as the server would", async () => {
  morning();
  const start = new Date(2026, 10, 5, 9, 0).getTime();
  const approve = await openForm({ start_time: start, end_time: new Date(2026, 10, 2, 9, 0).getTime() });
  expect(approve.disabled).toBe(true);
  expect(document.getElementById("launch-end-problem")!.textContent).toBe("Choose an end date after this campaign's start date.");
});

const pillRow = (name: string) => screen.getAllByText(name).map((el) => el.closest("[data-campaign-row]")).find(Boolean) as HTMLElement;
const pillApi = (status = "ACTIVE") =>
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === "POST") return { status: path.endsWith("/pause") ? "paused" : "active" };
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot", status }] }
      : launchReview("PAUSED");
  });
const greenPill = (row: HTMLElement) => row.querySelector(".text-success");

it.each([
  ["paused in Campaign Manager", { status: "PAUSED", ad_delivery: null, ads_not_running: 0 }, "Paused"],
  ["out of budget", { status: "ACTIVE", ad_delivery: "out_of_budget", ads_not_running: 1 }, "Out of budget"],
  ["rejected", { status: "ACTIVE", ad_delivery: "rejected", ads_not_running: 1 }, "Ads rejected"],
  ["in review", { status: "ACTIVE", ad_delivery: "in_review", ads_not_running: 1 }, "Ads in review"],
  ["held", { status: "ACTIVE", ad_delivery: "held", ads_not_running: 1 }, "Ads on hold"],
  ["with no ad switched on", { status: "ACTIVE", ad_delivery: "no_ads", ads_not_running: 0 }, "No ad running"],
  ["ended at LinkedIn", { status: "COMPLETED", ad_delivery: null, ads_not_running: 0 }, "Ended"],
  ["unread ads", { status: "ACTIVE", ad_delivery: "unread", ads_not_running: 0 }, "Active"],
  ["serving one ad of two", { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 1 }, "Live, 1 ad not running"],
] as const)("a campaign Zavi last turned on but LinkedIn reports %s never reads as a green Live", async (_label, live, label) => {
  pillApi();
  setCampaignStates("linkedin_ads", { "12345": live });
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText("Pilot");
  const row = pillRow("Pilot");
  expect(within(row).getByText(label)).toBeTruthy();
  expect(within(row).queryByText("Live")).toBeNull();
  expect(greenPill(row)).toBeNull();
});

it("only LinkedIn saying the ads serve earns the green Live, and it overrides a stored Paused the founder undid in Campaign Manager", async () => {
  pillApi("PAUSED");
  setCampaignStates("linkedin_ads", { "12345": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } });
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText("Pilot");
  expect(greenPill(pillRow("Pilot"))?.textContent).toBe("Live");
});

it("with no LinkedIn read yet the stored state is a muted Active, then the read arrives and moves the pill with no new request", async () => {
  pillApi();
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText("Pilot");
  expect(within(pillRow("Pilot")).getByText("Active")).toBeTruthy();
  expect(greenPill(pillRow("Pilot"))).toBeNull();
  const calls = api.mock.calls.length;
  act(() => setCampaignStates("linkedin_ads", { "12345": { status: "ACTIVE", ad_delivery: "rejected", ads_not_running: 1 } }));
  expect(within(pillRow("Pilot")).getByText("Ads rejected").getAttribute("title")).toContain("rejected");
  expect(api.mock.calls.length).toBe(calls);
  expect(apiFetch).not.toHaveBeenCalled();
});

it("a just-launched row reads Live, then yields to the read LinkedIn answers next: fresh ads go to review, not stay green", async () => {
  pillApi("PAUSED");
  const stale = vi.fn();
  window.addEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
  try {
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
    await waitFor(() => expect(greenPill(pillRow("Pilot"))?.textContent).toBe("Live"));
    expect(stale).toHaveBeenCalledTimes(1);
    expect((stale.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: "linkedin_ads" });
    act(() => setCampaignStates("linkedin_ads", { "12345": { status: "ACTIVE", ad_delivery: "in_review", ads_not_running: 1 } }));
    expect(within(pillRow("Pilot")).getByText("Ads in review")).toBeTruthy();
    expect(greenPill(pillRow("Pilot"))).toBeNull();
  } finally {
    window.removeEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
  }
});

it("a refused launch does not re-read the dashboard, a pause does, and so does a card that finished on the channel", async () => {
  pillApi("PAUSED");
  const stale = vi.fn();
  window.addEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
  try {
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    const approve = await screen.findByRole("button", { name: /Approve and launch/ });
    const works = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") throw new Error("Refused");
      return works(path, opts);
    });
    fireEvent.click(approve);
    await screen.findByText("Refused");
    expect(stale).not.toHaveBeenCalled();
    api.mockImplementation(works);
    act(() => setCampaignStates("linkedin_ads", { "12345": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    fireEvent.click(await within(pillRow("Pilot")).findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    act(() => announceChannelHistoryChanged("linkedin_ads"));
    expect(stale).toHaveBeenCalledTimes(2);
    act(() => announceChannelHistoryChanged("reddit_ads"));
    expect(stale).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
  }
});

it("non-regression guard: a ChatGPT row ignores the LinkedIn read and keeps its stored Live", async () => {
  api.mockImplementation(async (path: string) =>
    path.includes("?platform=") ? { campaigns: [{ id: "c1", provider_campaign_id: "12345", funding_source: "provider", name: "Chat one", status: "ACTIVE" }] } : {},
  );
  setCampaignStates("linkedin_ads", { "12345": { status: "PAUSED", ad_delivery: null, ads_not_running: 0 } });
  render(<BoundAdsCampaigns platform="chatgpt" />);
  await screen.findByText("Chat one");
  expect(within(pillRow("Chat one")).getByText("Live")).toBeTruthy();
});

it.each([
  ["wallet", false],
  ["provider", true],
])("an empty %s campaign whose setup card is closed tells the truth and offers no launch or Try again", async (funding, ownAccount) => {
  const closed = "10000000-0000-4000-8000-000000000099";
  let lists = 0;
  api.mockImplementation(async (path: string) => {
    if (path.includes("?platform=")) { lists += 1; return { campaigns: [{ id: closed, provider_campaign_id: "906182034", funding_source: funding, name: "Rejected card", setting_up: "closed" }] }; }
    return { budget: { status: "active" } };
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  const row = (await screen.findByText("Rejected card")).closest("[data-campaign-row]") as HTMLElement;
  expect(within(row).getByText(/setup card is closed, so it cannot launch and has nothing to pause\./)).toBeTruthy();
  if (ownAccount) expect(row.textContent).toContain("Start a new campaign, and remove this one in LinkedIn Campaign Manager.");
  else {
    expect(row.textContent).toContain("It stays paused in Zavi's ad account and cannot spend. Start a new campaign.");
    expect(row.textContent).not.toMatch(/Campaign Manager|remove this one/);
  }
  expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
  expect(within(row).getByText("Not finished")).toBeTruthy();
  expect(within(row).queryByText(/Try again/)).toBeNull();
  expect(within(row).queryByRole("button", { name: "Review launch" })).toBeNull();
  await new Promise((r) => setTimeout(r, 50));
  expect(lists).toBe(1);
});

describe("the launch form is a short summary that keeps every money fact", () => {
  const openForm = async (funding: string, review: Record<string, unknown> = {}, month: Record<string, unknown> = { monthly_usd: 1000, month_cap_usd: 1000, held_usd: 0, left_usd: 1000 }) => {
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: "active" };
      if (path === "/api/workspace/ad-budget") return { budget: { status: "active", ...month } };
      return path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "555101", funding_source: funding, name: "Spring" }] }
        : launchReview("PAUSED", { funding_source: funding, total_budget_cents: 10000, daily_budget_cents: 1500, end_time: Date.now() + 5 * 86400000, ...review });
    });
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    return screen.findByLabelText(/Total campaign budget/);
  };
  const approve = () => screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement;
  const launchPosts = () => api.mock.calls.filter(([p, o]: any[]) => p === `/api/ads/campaigns/${id}/launch` && o?.method === "POST");
  const below = (daily: string, floor: string) => `LinkedIn does not accept a total budget below the campaign's daily budget. This campaign can spend up to ${daily} a day, so enter a total of at least ${floor}.`;
  const alertNow = () => document.getElementById("launch-below-daily");
  it.each([["14.99"], ["10"]])("a total of %s on $15 a day is blocked, names the minimum, hides the summary, and cannot be submitted", async (value) => {
    const input = await openForm("wallet");
    fireEvent.change(input, { target: { value } });
    const message = await screen.findByRole("alert");
    expect(message.id).toBe("launch-below-daily");
    expect(message.textContent).toBe(below("$15.00", "$15.00"));
    expect(approve().disabled).toBe(true);
    expect(approve().getAttribute("aria-describedby")).toBe("launch-below-daily");
    expect(approve().textContent).toBe("Approve and launch");
    expect(Object.keys(launchSummary())).toEqual(["Wallet hold"]);
    expect(document.body.textContent).not.toMatch(/then it stops|stops at/);
    fireEvent.submit(input.closest("form")!);
    await act(async () => { await Promise.resolve(); });
    expect(launchPosts()).toEqual([]);
  });
  it.each([["15", 1500], ["15.01", 1501]])("a total of %s on $15 a day is open and sends those cents", async (value, cents) => {
    const input = await openForm("wallet");
    fireEvent.change(input, { target: { value } });
    expect(alertNow()).toBeNull();
    expect(approve().disabled).toBe(false);
    fireEvent.click(approve());
    await waitFor(() => expect(launchPosts()).toHaveLength(1));
    expect(JSON.parse(String(launchPosts()[0][1].body)).total_budget_cents).toBe(cents);
  });
  it("an empty total asks for the daily budget as the minimum, not LinkedIn's lower one, and is not called below daily", async () => {
    const input = await openForm("wallet");
    fireEvent.change(input, { target: { value: "" } });
    expect(alertNow()).toBeNull();
    expect(document.getElementById("launch-blocked")!.textContent).toContain("at least $15.00");
    expect((input as HTMLInputElement).min).toBe("15");
  });
  it("a campaign with no daily budget keeps LinkedIn's minimum only", async () => {
    const input = await openForm("wallet", { daily_budget_cents: null });
    fireEvent.change(input, { target: { value: "10" } });
    expect(alertNow()).toBeNull();
    expect(approve().disabled).toBe(false);
    fireEvent.change(input, { target: { value: "9.99" } });
    expect(approve().disabled).toBe(true);
    expect(document.getElementById("launch-blocked")!.textContent).toContain("at least $10.00");
  });
  it("a EUR account compares euros with euros, even where the dollar value would clear the daily budget", async () => {
    const input = await openForm("provider", { currency: "EUR", fx: { units_per_usd: 0.8, as_of: "2026-10-13" }, daily_budget_cents: 1200, total_budget_cents: 5000 });
    fireEvent.change(input, { target: { value: "11.99" } });
    expect(alertNow()!.textContent).toBe(below("€12.00", "€12.00"));
    expect(approve().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "12" } });
    expect(alertNow()).toBeNull();
    expect(approve().disabled).toBe(false);
  });
  it("a daily budget under LinkedIn's minimum still leads to a total that works", async () => {
    const input = await openForm("provider", { currency: "INR", fx: { units_per_usd: 83, as_of: "2026-10-13" }, daily_budget_cents: 50000, total_budget_cents: 100000 });
    fireEvent.change(input, { target: { value: "499.99" } });
    expect(alertNow()!.textContent).toBe(below("₹500.00", "₹830.00"));
    expect(approve().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "600" } });
    expect(alertNow()).toBeNull();
    expect(approve().disabled).toBe(true);
    expect(document.getElementById("launch-blocked")!.textContent).toContain("at least ₹830.00 (about $10.00)");
  });
  it("a relaunch is measured on the whole total: $2 left of $20 on $15 a day stays open and holds only the $2", async () => {
    const input = await openForm("wallet", { observed_spend_cents: 1800 });
    fireEvent.change(input, { target: { value: "20" } });
    expect(alertNow()).toBeNull();
    expect(approve().disabled).toBe(false);
    expect(launchSummary()["Set aside"]).toContain("$2.00 still to spend of the $20.00 total");
  });
  it("a relaunch whose whole total is under the daily budget is blocked", async () => {
    const input = await openForm("wallet", { observed_spend_cents: 1000 });
    fireEvent.change(input, { target: { value: "14.99" } });
    expect(alertNow()!.textContent).toBe(below("$15.00", "$15.00"));
    expect(approve().disabled).toBe(true);
  });
  it("when the month has less left than the daily budget, the form does not suggest a total LinkedIn would refuse", async () => {
    const input = await openForm("wallet", {}, { monthly_usd: 12, month_cap_usd: 12, held_usd: 0, left_usd: 12 });
    fireEvent.change(input, { target: { value: "20" } });
    const warning = await screen.findByText((_, el) => el?.id === "launch-over-month");
    expect(warning.textContent).toContain("A launch needs at least $15.00, so raise your monthly ad budget to launch.");
    expect(warning.textContent).not.toContain("lower the total");
  });
  it("this campaign's own hold counts toward the month, and the daily rule still stands apart from it", async () => {
    const input = await openForm("wallet", { own_hold_usd: 20 }, { monthly_usd: 5, month_cap_usd: 5, held_usd: 20, left_usd: 5 });
    fireEvent.change(input, { target: { value: "15" } });
    expect(alertNow()).toBeNull();
    expect(document.getElementById("launch-over-month")).toBeNull();
    expect(approve().disabled).toBe(false);
    fireEvent.change(input, { target: { value: "14" } });
    expect(alertNow()).not.toBeNull();
    expect(approve().disabled).toBe(true);
  });
  it("a wallet launch shows the limit, the hold, the return of unspent money, and late spend", async () => {
    await openForm("wallet");
    await waitFor(() => expect(launchSummary()["Daily limit"]).toBe("$15.00 a day"));
    const rows = launchSummary();
    expect(Object.keys(rows)).toEqual(["Daily limit", "Total", "End date", "Set aside", "Unspent money", "Wallet hold"]);
    expect(rows.Total).toBe("$100.00, then it stops");
    expect(rows["Set aside"]).toBe("$100.00 from your monthly ad budget");
    expect(rows["Unspent money"]).toMatch(/Goes back .* ends or is paused/);
    expect(rows["Wallet hold"]).toMatch(/reserved before launch.*72 hours/);
    expect(screen.getByText("Late spend is still charged.")).toBeTruthy();
    expect(screen.queryByText(/does not debit/)).toBeNull();
  });
  it("own billing never claims a wallet hold or late wallet charges", async () => {
    await openForm("provider");
    await waitFor(() => expect(launchSummary()["Daily limit"]).toBe("$15.00 a day"));
    expect(launchSummary()["Wallet hold"]).toBeUndefined();
    expect(screen.getByText("This launch does not debit your Zavi wallet.")).toBeTruthy();
    expect(screen.queryByText(/Late spend/)).toBeNull();
  });
  it("the summary follows the total the founder types", async () => {
    const input = await openForm("wallet");
    fireEvent.change(input, { target: { value: "250" } });
    expect(launchSummary().Total).toBe("$250.00, then it stops");
    expect(launchSummary()["Set aside"]).toBe("$250.00 from your monthly ad budget");
  });
  it("a launch that does not fit stays blocked, with its link, under the summary", async () => {
    await openForm("wallet", {}, { monthly_usd: 40, month_cap_usd: 40, held_usd: 0, left_usd: 40 });
    const warning = await screen.findByText((_, el) => el?.id === "launch-over-month");
    expect(warning.textContent).toContain("does not fit the $40.00 left this month");
    expect(within(warning).getByRole("link", { name: "Open your monthly ad budget" }).getAttribute("href")).toBeTruthy();
    expect(warning.compareDocumentPosition(document.getElementById("launch-pace")!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("two campaigns with one name: the form names which one it is, by created time, daily budget and id", async () => {
  const other = "10000000-0000-4000-8000-000000000077";
  const camps = [
    { id, provider_campaign_id: "555101", funding_source: "provider", name: "Spring", created_at: "2026-10-28T10:15:00.000Z" },
    { id: other, provider_campaign_id: "555202", funding_source: "provider", name: "Spring", created_at: "2026-10-20T08:05:00.000Z" },
  ];
  api.mockImplementation(async (path: string) => {
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active", monthly_usd: 1000, month_cap_usd: 1000, held_usd: 0, left_usd: 1000 } };
    if (path.includes("?platform=")) return { campaigns: camps };
    return path.includes(other)
      ? launchReview("PAUSED", { campaign_binding_id: other, name: "Spring", daily_budget_cents: 900 })
      : launchReview("PAUSED", { campaign_binding_id: id, name: "Spring", daily_budget_cents: 1500 });
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  const [, second] = await screen.findAllByRole("button", { name: "Review launch" });
  fireEvent.click(second);
  const identity = await screen.findByTestId("launch-identity");
  const created = new Date(camps[1].created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  expect(identity.textContent).toBe(`Created ${created} · $9.00 a day now · Campaign 555202`);
  expect(identity.textContent).not.toContain("555101");
  const rows = document.querySelectorAll("[data-campaign-row]");
  expect(rows[1].textContent).toContain(`Created ${created}`);
  expect(rows[0].textContent).not.toContain(`Created ${created}`);
});

it("a campaign LinkedIn holds for budget reads Out of budget and can still be paused", async () => {
  api.mockImplementation(async (path: string) => {
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    return path.includes("?platform=")
      ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot", status: "OUT_OF_BUDGET" }] }
      : launchReview("ACTIVE");
  });
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText("Pilot");
  expect(screen.getByText("Out of budget")).toBeTruthy();
  expect(screen.queryByText("Live")).toBeNull();
  expect(screen.queryByText("Active")).toBeNull();
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
});

describe("Review launch is only offered on a campaign that is not running", () => {
  const list = (campaign: Record<string, unknown>) => {
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: "paused" };
      if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
      return path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "555101", funding_source: "wallet", name: "Spring", ...campaign }] }
        : launchReview("PAUSED", { daily_budget_cents: 1500 });
    });
  };
  const openList = async (campaign: Record<string, unknown>, state?: { status: string; ad_delivery?: string | null; ads_not_running?: number }) => {
    list(campaign);
    if (state) act(() => setCampaignStates("linkedin_ads", { "555101": { ad_delivery: null, ads_not_running: 0, ...state } as never }));
    render(<BoundAdsCampaigns platform="linkedin" />);
    return screen.findByText("Spring");
  };
  const offered = () => screen.queryByRole("button", { name: "Review launch" }) !== null;
  it.each([
    ["delivering", "serving", "Live"],
    ["with its ad under review", "in_review", "Ads in review"],
    ["with its ad rejected", "rejected", "Ads rejected"],
    ["on hold", "held", "Ads on hold"],
    ["with no ad switched on", "no_ads", "No ad running"],
    ["out of budget", "out_of_budget", "Out of budget"],
    ["whose ads could not be read", "unread", "Active"],
  ])("a campaign LinkedIn shows ACTIVE %s has no Review launch, and keeps Pause", async (_label, ad_delivery, pill) => {
    await openList({}, { status: "ACTIVE", ad_delivery });
    expect(screen.getByText(pill)).toBeTruthy();
    expect(offered()).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });
  it.each([["active"], ["live"], ["OUT_OF_BUDGET"]])("with no LinkedIn read yet, a stored %s campaign has no Review launch", async (status) => {
    await openList({ status });
    expect(offered()).toBe(false);
  });
  it.each([["PAUSED"], ["DRAFT"]])("a campaign LinkedIn shows %s keeps Review launch, even if the stored status still says active", async (status) => {
    await openList({ status: "active" }, { status });
    expect(offered()).toBe(true);
  });
  it("a stopped or never-read campaign keeps Review launch", async () => {
    await openList({ status: "paused" });
    expect(offered()).toBe(true);
    cleanup();
    await openList({});
    expect(offered()).toBe(true);
  });
  it("a campaign that goes live while the page is open loses it the moment LinkedIn's status arrives", async () => {
    await openList({}, { status: "PAUSED" });
    expect(offered()).toBe(true);
    act(() => setCampaignStates("linkedin_ads", { "555101": { status: "ACTIVE", ad_delivery: "in_review", ads_not_running: 0 } }));
    await waitFor(() => expect(offered()).toBe(false));
  });
  it("launching here takes it away, and pausing here gives it back even over a stale live reading", async () => {
    await openList({}, { status: "PAUSED" });
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: path.endsWith("/pause") ? "paused" : "active" };
      if (path === "/api/workspace/ad-budget") return { budget: { status: "active", left_usd: 1000, monthly_usd: 1000, month_cap_usd: 1000 } };
      return path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "555101", funding_source: "wallet", name: "Spring" }] }
        : launchReview("PAUSED", { daily_budget_cents: 1500, end_time: Date.now() + 5 * 86400000 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
    await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
    await waitFor(() => expect(offered()).toBe(false));
    act(() => setCampaignStates("linkedin_ads", { "555101": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(offered()).toBe(true));
  });
  it("ChatGPT campaigns are untouched", async () => {
    list({ status: "active" });
    render(<BoundAdsCampaigns platform="chatgpt" />);
    expect(await screen.findByRole("button", { name: "Review launch" })).toBeTruthy();
  });
});

describe("Pause is withheld only when LinkedIn or the founder's own pause proves the campaign is paused", () => {
  const serve = (campaigns: Array<Record<string, unknown>>) =>
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: "paused" };
      return path.includes("?platform=") ? { campaigns } : {};
    });
  const rowOf = (name: string) => screen.getByText(name).closest("[data-campaign-row]") as HTMLElement;
  const pauseOf = (name: string) => within(rowOf(name)).queryByRole("button", { name: "Pause" });

  it.each([["paused"], ["PAUSED"], ["draft"], ["DRAFT"]])("stored %s with LinkedIn's live read unavailable still shows Paused but keeps Pause, so a campaign reactivated outside Zavi is not stranded", async (status) => {
    serve([{ id: "p1", provider_campaign_id: "1", funding_source: "provider", name: "Stored paused", status }]);
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Stored paused");
    expect(within(rowOf("Stored paused")).getByText("Paused")).toBeTruthy();
    expect(pauseOf("Stored paused")).not.toBeNull();
    expect(within(rowOf("Stored paused")).getByRole("button", { name: "Review launch" })).toBeTruthy();
  });

  it("a campaign stored paused and reactivated in Campaign Manager, with the live read failed, can still be stopped from Zavi: one pause is sent and the row settles", async () => {
    const posts: string[] = [];
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        posts.push(path);
        return { status: "paused" };
      }
      return path.includes("?platform=") ? { campaigns: [{ id: "r1", provider_campaign_id: "5", funding_source: "provider", name: "Reactivated", status: "PAUSED" }] } : {};
    });
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Reactivated");
    fireEvent.click(pauseOf("Reactivated")!);
    await screen.findByText("LinkedIn confirmed the campaign is paused.");
    expect(posts).toEqual(["/api/ads/campaigns/r1/pause"]);
    expect(pauseOf("Reactivated")).toBeNull();
    expect(within(rowOf("Reactivated")).getByText("Paused")).toBeTruthy();
  });

  it("Pause on a campaign that really was paused says so and sends nothing further", async () => {
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: "already_paused" };
      return path.includes("?platform=") ? { campaigns: [{ id: "r2", provider_campaign_id: "6", funding_source: "provider", name: "Truly paused", status: "PAUSED" }] } : {};
    });
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Truly paused");
    fireEvent.click(pauseOf("Truly paused")!);
    await screen.findByText("LinkedIn shows this campaign was already paused.");
    expect(pauseOf("Truly paused")).toBeNull();
    expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
  });

  it("a stored Paused whose pause failed keeps Pause so the founder can try again", async () => {
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") throw new Error("LinkedIn is busy.");
      return path.includes("?platform=") ? { campaigns: [{ id: "r3", provider_campaign_id: "4", funding_source: "provider", name: "Busy row", status: "PAUSED" }] } : {};
    });
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Busy row");
    fireEvent.click(pauseOf("Busy row")!);
    await screen.findByText("LinkedIn is busy.");
    expect(pauseOf("Busy row")).not.toBeNull();
  });

  it("a live ACTIVE read beats a stored Paused: Pause stays and Review launch goes", async () => {
    serve([{ id: "r4", provider_campaign_id: "3", funding_source: "provider", name: "Live beats stored", status: "PAUSED" }]);
    act(() => setCampaignStates("linkedin_ads", { "3": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Live beats stored");
    expect(pauseOf("Live beats stored")).not.toBeNull();
    expect(within(rowOf("Live beats stored")).queryByRole("button", { name: "Review launch" })).toBeNull();
  });

  it.each([["PAUSED"], ["DRAFT"]])("a live %s read removes Pause even when the stored status says active", async (status) => {
    serve([{ id: "p2", provider_campaign_id: "2", funding_source: "provider", name: "Live paused", status: "active" }]);
    act(() => setCampaignStates("linkedin_ads", { "2": { status, ad_delivery: null, ads_not_running: 0 } }));
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Live paused");
    expect(pauseOf("Live paused")).toBeNull();
  });

  it.each([
    ["no stored status and no live read", {}, undefined],
    ["an unrecognised stored status", { status: "mystery" }, undefined],
    ["an empty stored status", { status: "" }, undefined],
    ["a null stored status", { status: null }, undefined],
    ["a live read that LinkedIn could not classify", {}, { status: "SOMETHING_NEW", ad_delivery: null, ads_not_running: 0 }],
  ])("keeps Pause when status is genuinely unknown: %s", async (_label, stored, live) => {
    serve([{ id: "u1", provider_campaign_id: "9", funding_source: "provider", name: "Unknown row", ...stored }]);
    if (live) act(() => setCampaignStates("linkedin_ads", { "9": live as never }));
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Unknown row");
    expect(pauseOf("Unknown row")).not.toBeNull();
  });

  it("keeps Pause on an active row, then drops it once a live PAUSED read arrives, then restores it when LinkedIn shows ACTIVE again", async () => {
    serve([{ id: "t1", provider_campaign_id: "7", funding_source: "provider", name: "Flip row", status: "active" }]);
    act(() => setCampaignStates("linkedin_ads", { "7": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Flip row");
    expect(pauseOf("Flip row")).not.toBeNull();
    act(() => setCampaignStates("linkedin_ads", { "7": { status: "PAUSED", ad_delivery: null, ads_not_running: 0 } }));
    await waitFor(() => expect(pauseOf("Flip row")).toBeNull());
    act(() => setCampaignStates("linkedin_ads", { "7": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    await waitFor(() => expect(pauseOf("Flip row")).not.toBeNull());
  });

  it("pressing Pause on an active row sends one pause and then offers no second one", async () => {
    serve([{ id: "t2", provider_campaign_id: "8", funding_source: "provider", name: "Once row", status: "active" }]);
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Once row");
    fireEvent.click(pauseOf("Once row")!);
    await waitFor(() => expect(pauseOf("Once row")).toBeNull());
    expect(api.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
  });

  it("ChatGPT rows keep Pause whatever their stored status, including paused", async () => {
    serve([
      { id: "c1", provider_campaign_id: "1", funding_source: "provider", name: "Chat paused", status: "paused" },
      { id: "c2", provider_campaign_id: "2", funding_source: "provider", name: "Chat draft", status: "draft" },
      { id: "c3", provider_campaign_id: "3", funding_source: "provider", name: "Chat none" },
    ]);
    act(() => setCampaignStates("linkedin_ads", { "1": { status: "PAUSED", ad_delivery: null, ads_not_running: 0 } }));
    render(<BoundAdsCampaigns platform="chatgpt" />);
    await screen.findByText("Chat paused");
    for (const n of ["Chat paused", "Chat draft", "Chat none"]) expect(pauseOf(n)).not.toBeNull();
  });
});

describe("the launch form answers before Approve what the server would refuse", () => {
  const UNCONFIRMED = "This launch may have reached LinkedIn, but Zavi could not confirm it. Zavi tried to pause the campaign to be safe, but it may still be running. Check the campaign in LinkedIn Campaign Manager and pause it there if it is running, then review the launch again. The budget set aside for it stays held until Zavi confirms what happened.";
  const launchPosts = () => api.mock.calls.filter(([p, o]: any[]) => p === `/api/ads/campaigns/${id}/launch` && o?.method === "POST");
  const listReads = () => api.mock.calls.filter(([p]: any[]) => String(p).includes("?platform=")).length;
  const approve = () => screen.getByRole("button", { name: /Approve and launch/ }) as HTMLButtonElement;
  const mount = (opts: { review?: (n: number) => Record<string, unknown>; post?: (n: number) => Promise<unknown>; rows?: (n: number) => Array<Record<string, unknown>>; wallet?: unknown; reservations?: unknown; funding?: string }) => {
    let reviews = 0;
    let posts = 0;
    let lists = 0;
    const funding = opts.funding ?? "provider";
    api.mockImplementation(async (path: string, o?: RequestInit) => {
      if (o?.method === "POST") return opts.post ? opts.post(++posts) : { status: "active" };
      if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
      if (path === "/api/ads/wallet") return opts.wallet ?? {};
      if (path === "/api/ads/wallet/reservations") return opts.reservations ?? {};
      if (path.includes("?platform=")) {
        lists++;
        return { campaigns: opts.rows ? opts.rows(lists) : [{ id, provider_campaign_id: "12345", funding_source: funding, name: "Pilot" }] };
      }
      reviews++;
      return launchReview("PAUSED", { funding_source: funding, ...(opts.review ? opts.review(reviews) : {}) });
    });
    return render(<BoundAdsCampaigns platform="linkedin" />);
  };

  it("an unclear launch closes the form, hides Review launch on that row, says Zavi is checking, and re-reads the rows, wallet and dashboard until the server settles it", async () => {
    const stale = vi.fn();
    window.addEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
    try {
      let pending = true;
      mount({
        funding: "wallet",
        post: async () => { throw Object.assign(new Error(UNCONFIRMED), { status: 409, code: "linkedin_launch_outcome_unknown" }); },
        rows: (n) => [{ id, provider_campaign_id: "12345", funding_source: "wallet", name: "Pilot", ...(n > 1 && pending ? { launch_pending: true } : {}) }],
      });
      fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
      fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
      await screen.findByText(/^Zavi is checking whether this launch went through… It may already be running/);
      expect(screen.queryByRole("button", { name: /Approve and launch/ })).toBeNull();
      expect(document.body.textContent).not.toContain(UNCONFIRMED);
      const row = pillRow("Pilot");
      expect(within(row).queryByRole("button", { name: "Review launch" })).toBeNull();
      expect(within(row).getByTestId("launch-checking").textContent).toBe("Zavi is checking whether this launch went through…");
      expect(within(row).getByText("Checking launch")).toBeTruthy();
      expect(within(row).getByRole("button", { name: "Pause" })).toBeTruthy();
      expect(stale).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(listReads()).toBe(2));
      await act(async () => { await Promise.resolve(); });
      expect(within(pillRow("Pilot")).queryByRole("button", { name: "Review launch" })).toBeNull();
      expect(launchPosts()).toHaveLength(1);
      pending = false;
      act(() => announceChannelHistoryChanged("linkedin_ads"));
      expect(await within(pillRow("Pilot")).findByRole("button", { name: "Review launch" })).toBeTruthy();
      expect(within(pillRow("Pilot")).queryByTestId("launch-checking")).toBeNull();
    } finally {
      window.removeEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
    }
  });

  it("an unclear launch is told apart by the server's code, not its wording: a reworded message still reads as checking, and a plain conflict naming LinkedIn stays an error", async () => {
    let code = "linkedin_launch_outcome_unknown";
    mount({
      post: async () => { throw Object.assign(new Error(code === "linkedin_launch_outcome_unknown" ? "Zavi could not confirm this launch." : "This launch may have reached LinkedIn earlier today."), { status: 409, code }); },
      rows: () => [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
    await screen.findByText(/^Zavi is checking whether this launch went through… It may already be running/);
    expect(document.body.textContent).not.toContain("Zavi could not confirm this launch.");
    cleanup();
    code = "ads_launch_conflict";
    mount({
      post: async () => { throw Object.assign(new Error("This launch may have reached LinkedIn earlier today."), { status: 409, code }); },
      rows: () => [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot" }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
    await screen.findByText("This launch may have reached LinkedIn earlier today.");
    expect(screen.queryByTestId("launch-checking")).toBeNull();
    expect(screen.getByRole("button", { name: /Approve and launch/ })).toBeTruthy();
  });

  it("a row the server still marks launch_pending offers no Review launch from the first read", async () => {
    mount({ rows: () => [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot", launch_pending: true }] });
    const row = await waitFor(() => pillRow("Pilot"));
    expect(within(row).getByTestId("launch-checking")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Review launch" })).toBeNull();
  });

  it.each([
    ["the account is not ready to serve", "LinkedIn reports that the advertiser account is not ready to serve."],
    ["a billing hold", "LinkedIn has put this ad account on a billing hold."],
    ["ads not ready", "One or more ads are not ready for launch."],
  ])("the server's launch blocker for %s shows at the top before anything is typed, and Approve stays off", async (_label, blocker) => {
    mount({ review: () => ({ launch_blocker: blocker }) });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    const alert = await waitFor(() => {
      const el = document.getElementById("launch-blocker");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(alert.textContent).toBe(`${blocker} It cannot launch until this is fixed.`);
    const form = alert.closest("form")!;
    expect(form.firstElementChild!.nextElementSibling).toBe(alert);
    expect((screen.getByLabelText("Total campaign budget (USD)") as HTMLInputElement).disabled).toBe(true);
    expect(approve().disabled).toBe(true);
    expect(approve().getAttribute("aria-describedby")).toBe("launch-blocker");
    fireEvent.submit(form);
    await act(async () => { await Promise.resolve(); });
    expect(launchPosts()).toEqual([]);
  });

  it.each([["50"], ["49.99"]])("a relaunch total of %s on a campaign that already spent $50 is refused in the form and never shows $0.00 still to spend", async (value) => {
    mount({ review: () => ({ observed_spend_cents: 5000, total_budget_cents: 8000, end_time: Date.now() + 5 * 86400000 }) });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    fireEvent.change(await screen.findByLabelText("Total campaign budget (USD)"), { target: { value } });
    expect(document.getElementById("launch-total-spent")!.textContent).toBe("This campaign has already spent $50.00, and its total budget covers its whole life, so enter a total above $50.00.");
    expect(document.body.textContent).not.toMatch(/\$0\.00 still to spend|-\$/);
    expect(document.getElementById("launch-blocked")).toBeNull();
    expect(approve().disabled).toBe(true);
    expect(approve().getAttribute("aria-describedby")).toBe("launch-total-spent");
    fireEvent.submit(approve().closest("form")!);
    await act(async () => { await Promise.resolve(); });
    expect(launchPosts()).toEqual([]);
    fireEvent.change(screen.getByLabelText("Total campaign budget (USD)"), { target: { value: "50.01" } });
    expect(document.getElementById("launch-total-spent")).toBeNull();
    expect(approve().disabled).toBe(false);
  });

  it.each<[string, string, { snapshot?: string; currency?: string; fx?: { units_per_usd: number; as_of: string } }]>([
    ["the campaign changed", "The campaign or its ads changed. Review the launch again.", { snapshot: "b".repeat(64) }],
    ["the exchange rate moved", "The exchange rate moved since this launch was approved, so it now comes to $130.00, more than 5% above the $120.00 approved. Nothing was sent to LinkedIn. Review the launch again.", { currency: "EUR", fx: { units_per_usd: 0.77, as_of: "2026-11-03" } }],
  ])("after a review-again refusal because %s, the open form re-reads the review in place and the next Approve sends the fresh one", async (_label, refusal, fresh) => {
    mount({
      review: (n) => (n === 1 ? (fresh.currency ? { currency: "EUR", fx: { units_per_usd: 0.8, as_of: "2026-11-02" } } : {}) : fresh),
      post: async (n) => {
        if (n === 1) throw Object.assign(new Error(refusal), { status: 409, code: "ads_launch_conflict" });
        return { status: "active" };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    const input = await screen.findByLabelText(/Total campaign budget/);
    fireEvent.change(input, { target: { value: "123" } });
    fireEvent.click(approve());
    await screen.findByText(refusal.replace("Review the launch again.", "The launch review below is now up to date. Check it, then approve again."));
    expect((screen.getByLabelText(/Total campaign budget/) as HTMLInputElement).value).toBe("123");
    fireEvent.click(approve());
    await screen.findByText("LinkedIn Ads confirmed the campaign is active.");
    const [first, second] = launchPosts().map(([, o]: any[]) => JSON.parse(String(o.body)));
    expect(first.total_budget_cents).toBe(12300);
    expect(second.total_budget_cents).toBe(12300);
    if (fresh.snapshot) {
      expect(first.snapshot).toBe("a".repeat(64));
      expect(second.snapshot).toBe(fresh.snapshot);
    } else {
      expect(first.reviewed_units_per_usd).toBe(0.8);
      expect(second.reviewed_units_per_usd).toBe(0.77);
    }
  });

  it("a wallet launch shows what the wallet has for this campaign against what it needs, and refuses up front when short", async () => {
    mount({
      funding: "wallet",
      wallet: { available_cents: 3000, balance_cents: 9000, reserved_cents: 6000 },
      reservations: { reservations: [{ campaign_binding_id: id, reserved_cents: 1000 }, { campaign_binding_id: "other", reserved_cents: 5000 }] },
      review: () => ({ observed_spend_cents: 0, end_time: Date.now() + 5 * 86400000 }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    const input = await screen.findByLabelText("Total campaign budget (USD)");
    await screen.findByText(/Paid from your shared wallet, \$40\.00 available for this campaign/);
    expect(document.body.textContent).not.toContain("Your shared wallet covers this campaign");
    fireEvent.change(input, { target: { value: "50" } });
    expect(document.getElementById("launch-wallet-short")!.textContent).toBe("Your shared wallet has $40.00 available for this campaign, and this launch needs $50.00 set aside, so it cannot launch. Add funds to your shared wallet above, or lower the total budget.");
    expect(launchSummary()["Shared wallet"]).toBe("$40.00 available, $50.00 needed");
    expect(approve().disabled).toBe(true);
    expect(approve().getAttribute("aria-describedby")).toBe("launch-wallet-short");
    fireEvent.submit(input.closest("form")!);
    await act(async () => { await Promise.resolve(); });
    expect(launchPosts()).toEqual([]);
    fireEvent.change(input, { target: { value: "40" } });
    expect(document.getElementById("launch-wallet-short")).toBeNull();
    expect(launchSummary()["Shared wallet"]).toBe("$40.00 available, $40.00 needed");
    expect(approve().disabled).toBe(false);
  });

  it("a wallet read that fails keeps the launch available and claims no amount", async () => {
    mount({ funding: "wallet", wallet: null as unknown as object, review: () => ({ end_time: Date.now() + 5 * 86400000 }) });
    fireEvent.click(await screen.findByRole("button", { name: "Review launch" }));
    await screen.findByLabelText("Total campaign budget (USD)");
    expect(document.body.textContent).toContain("Paid from your shared wallet ·");
    expect(launchSummary()["Shared wallet"]).toBeUndefined();
    expect(approve().disabled).toBe(false);
  });
});

describe("a pause LinkedIn has not taken yet (Flow 16)", () => {
  const QUEUED = "Zavi saved your pause request and will keep retrying it. Check back in a few minutes.";
  const listReads = () => api.mock.calls.filter(([p]: any[]) => p === "/api/ads/campaigns?platform=linkedin").length;
  const pausePosts = () => api.mock.calls.filter(([p, o]: any[]) => String(p).endsWith("/pause") && o?.method === "POST");
  it("a pause the server queued after a LinkedIn 429 or 5xx shows Pausing with no Pause button and no red error, and the row re-reads itself until the pause lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let server: "live" | "pending" | "paused" = "live";
      api.mockImplementation(async (path: string, o?: RequestInit) => {
        if (o?.method === "POST") {
          server = "pending";
          throw Object.assign(new Error(QUEUED), { status: 503, code: "ads_pause_queued" });
        }
        if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
        if (path.includes("?platform="))
          return { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "wallet", name: "Spring", ...(server === "live" ? { status: "ACTIVE" } : server === "pending" ? { pause_pending: true } : { status: "PAUSED" }) }] };
        return {};
      });
      render(<BoundAdsCampaigns platform="linkedin" />);
      fireEvent.click(await within(await waitFor(() => pillRow("Spring"))).findByRole("button", { name: "Pause" }));
      await screen.findByTestId("pause-pending");
      const row = pillRow("Spring");
      expect(within(row).getByTestId("pause-pending").textContent).toBe("Pausing… Zavi keeps retrying.");
      expect(within(row).getByText("Pausing")).toBeTruthy();
      expect(within(row).queryByText("Live")).toBeNull();
      expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
      expect(within(row).queryByRole("button", { name: "Review launch" })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe(QUEUED);
      expect(document.body.textContent).not.toContain("LinkedIn confirmed the campaign is paused.");
      await waitFor(() => expect(listReads()).toBe(2));
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(listReads()).toBe(3);
      expect(within(pillRow("Spring")).getByTestId("pause-pending")).toBeTruthy();
      expect(within(pillRow("Spring")).queryByRole("button", { name: "Pause" })).toBeNull();
      server = "paused";
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      await waitFor(() => expect(within(pillRow("Spring")).queryByTestId("pause-pending")).toBeNull());
      expect(within(pillRow("Spring")).getByText("Paused")).toBeTruthy();
      const settled = listReads();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(listReads()).toBe(settled);
      expect(pausePosts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a row the server marks pause_pending on the first read offers no Pause and keeps re-reading; any other pause failure stays a red error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.mockImplementation(async (path: string, o?: RequestInit) => {
        if (o?.method === "POST") throw Object.assign(new Error("LinkedIn refused the pause."), { status: 503, code: "ads_credentials_unavailable" });
        if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
        if (path.includes("?platform="))
          return { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Held", pause_pending: true }, { id: "r2", provider_campaign_id: "2", funding_source: "provider", name: "Other", status: "ACTIVE" }] };
        return {};
      });
      render(<BoundAdsCampaigns platform="linkedin" />);
      const held = await waitFor(() => pillRow("Held"));
      expect(within(held).getByTestId("pause-pending")).toBeTruthy();
      expect(within(held).queryByRole("button", { name: "Pause" })).toBeNull();
      const before = listReads();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(listReads()).toBe(before + 1);
      fireEvent.click(within(pillRow("Other")).getByRole("button", { name: "Pause" }));
      expect((await screen.findByRole("alert")).textContent).toBe("LinkedIn refused the pause.");
      expect(within(pillRow("Other")).queryByTestId("pause-pending")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LinkedIn rows after a pause, an end and a launch whose record is still finishing", () => {
  const rowOf = (name: string) => screen.getByText(name).closest("[data-campaign-row]") as HTMLElement;
  const listReads = () => api.mock.calls.filter(([p]: any[]) => String(p).includes("?platform=")).length;
  const posts = () => api.mock.calls.filter(([, o]: any[]) => o?.method === "POST");

  it("re-reads Zavi's campaign list after a confirmed pause, and a dashboard change with no entry for the campaign keeps it Paused with no second Pause", async () => {
    let paused = false;
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST" && path.endsWith("/pause")) {
        paused = true;
        return { status: "paused" };
      }
      return path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "wallet", name: "Spring", status: paused ? "PAUSED" : "ACTIVE" }] }
        : {};
    });
    act(() => setCampaignStates("linkedin_ads", { "12345": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Spring");
    expect(within(rowOf("Spring")).getByText("Live")).toBeTruthy();
    const before = listReads();
    fireEvent.click(within(rowOf("Spring")).getByRole("button", { name: "Pause" }));
    await screen.findByText(/LinkedIn confirmed the campaign is paused\./);
    await waitFor(() => expect(listReads()).toBe(before + 1));
    act(() => setCampaignStates("linkedin_ads", {}));
    act(() => setCampaignStates("linkedin_ads", { "777": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    await new Promise((r) => setTimeout(r, 20));
    const row = rowOf("Spring");
    expect(within(row).getByText("Paused")).toBeTruthy();
    expect(within(row).queryByText(/Live|Active/)).toBeNull();
    expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("keeps the confirmed Paused mark when the list re-read still says active and the dashboard has no entry", async () => {
    api.mockImplementation(async (path: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? { status: "paused" }
        : path.includes("?platform=")
          ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Lagging", status: "ACTIVE" }] }
          : {},
    );
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Lagging");
    fireEvent.click(within(rowOf("Lagging")).getByRole("button", { name: "Pause" }));
    await screen.findByText("LinkedIn confirmed the campaign is paused.");
    act(() => setCampaignStates("linkedin_ads", { "999": { status: "PAUSED", ad_delivery: null, ads_not_running: 0 } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(rowOf("Lagging")).getByText("Paused")).toBeTruthy();
    expect(within(rowOf("Lagging")).queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("a fresh dashboard read for the campaign still replaces the local Paused mark", async () => {
    api.mockImplementation(async (path: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? { status: "paused" }
        : path.includes("?platform=")
          ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Resumed", status: "ACTIVE" }] }
          : {},
    );
    render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Resumed");
    fireEvent.click(within(rowOf("Resumed")).getByRole("button", { name: "Pause" }));
    await screen.findByText("LinkedIn confirmed the campaign is paused.");
    act(() => setCampaignStates("linkedin_ads", { "12345": { status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0 } }));
    await waitFor(() => expect(within(rowOf("Resumed")).getByText("Live")).toBeTruthy());
    expect(within(rowOf("Resumed")).getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("offers no launch and no pause on a campaign LinkedIn shows ended, and no launch on one Zavi's record shows ended, each with a reason, sending nothing", async () => {
    api.mockImplementation(async (path: string) =>
      path.includes("?platform=")
        ? { campaigns: [
            { id: "e1", provider_campaign_id: "31", funding_source: "provider", name: "Read ended", status: "ACTIVE" },
            { id: "e2", provider_campaign_id: "32", funding_source: "wallet", name: "Stored ended", status: "ENDED" },
            { id: "e3", provider_campaign_id: "33", funding_source: "provider", name: "Still paused", status: "PAUSED" },
          ] }
        : {},
    );
    act(() => setCampaignStates("linkedin_ads", { "31": { status: "COMPLETED", ad_delivery: null, ads_not_running: 0 } }));
    render(<BoundAdsCampaigns platform="linkedin" walletOff />);
    await screen.findByText("Read ended");
    const read = rowOf("Read ended");
    expect(within(read).getByText("Ended")).toBeTruthy();
    expect(within(read).queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(within(read).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(read).getByTestId("ended-row").textContent).toBe("This campaign has ended, so it cannot be launched or paused.");
    const stored = rowOf("Stored ended");
    expect(within(stored).queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(within(stored).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(within(stored).getByTestId("ended-row").textContent).toBe("This campaign has ended, so it cannot be launched again.");
    expect(within(stored).queryByTestId("wallet-off-launch")).toBeNull();
    expect(within(rowOf("Still paused")).getByRole("button", { name: "Review launch" })).toBeTruthy();
    expect(within(rowOf("Still paused")).queryByTestId("ended-row")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("shows a launch that is live while Zavi finishes its record as a success with the server's words, not an error", async () => {
    const NOTICE = "Your campaign is live on LinkedIn. Zavi is still finishing its own record of this launch, so the campaign may show as launching on your LinkedIn Ads page for a few minutes. There is nothing you need to do.";
    api.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return { status: "active", record_pending: true, notice: NOTICE };
      if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
      return path.includes("?platform=")
        ? { campaigns: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Pilot", status: "PAUSED" }] }
        : { campaign_binding_id: id, name: "Pilot", account_id: "42", funding_source: "provider", status: "PAUSED", snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, observed_spend_cents: 0, end_time: Date.now() + 3 * 86400000, ads: [{ id: "8", status: "PAUSED" }] };
    });
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(within(await waitFor(() => rowOf("Pilot"))).getByRole("button", { name: "Review launch" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve and launch/ }));
    const notice = await screen.findByTestId("row-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe(NOTICE);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/confirmed the campaign is active|didn't hear back|checking whether/)).toBeNull();
    expect(within(rowOf("Pilot")).getByText("Live")).toBeTruthy();
    expect(within(rowOf("Pilot")).queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve and launch|Try again/ })).toBeNull();
    expect(posts()).toHaveLength(1);
  });
});

describe("each campaign row names how that campaign is paid", () => {
  const own = "10000000-0000-4000-8000-000000000002";
  const legacy = "10000000-0000-4000-8000-000000000003";
  beforeEach(() => {
    api.mockImplementation(async (path: string) =>
      path === "/api/workspace/ad-budget"
        ? { budget: { status: "active" } }
        : path.includes("?platform=")
          ? { campaigns: [
              { id: own, provider_campaign_id: "905998344", funding_source: "provider", provider_account_id: "559148166", name: "Own billing" },
              { id, provider_campaign_id: "906039044", funding_source: "wallet", provider_account_id: "510000001", name: "Wallet paid" },
              { id: legacy, provider_campaign_id: "906000001", funding_source: "provider", name: "No account read" },
            ] }
          : {},
    );
  });
  const lines = () =>
    screen.getAllByRole("listitem").map((row) => within(row).getByText(/Paid |Billed /).textContent);
  it("keeps each row's own funding and account whichever way the workspace pays now", async () => {
    const view = render(<BoundAdsCampaigns platform="linkedin" />);
    await screen.findByText("Wallet paid");
    const expected = [
      "Paid by your ad account 559148166",
      "Paid from your Zavi shared wallet",
      "Billed to your own LinkedIn Ads account",
    ];
    expect(lines()).toEqual(expected);
    view.rerender(<BoundAdsCampaigns platform="linkedin" walletOff />);
    expect(lines()).toEqual(expected);
    expect(screen.getAllByText("Paid from your Zavi shared wallet")).toHaveLength(1);
    expect(screen.queryByText(/510000001/)).toBeNull();
  });
});

it("must catch: picking another ad account re-reads the campaign list in place, so the old account's cards leave without a reload; a plain stale notice and another channel's pick do not", async () => {
  const listReads = () => api.mock.calls.filter(([path]) => String(path).includes("?platform=linkedin")).length;
  const campaigns = { current: [{ id, provider_campaign_id: "12345", funding_source: "provider", name: "Old account campaign" }] as Array<Record<string, unknown>> };
  api.mockImplementation(async (path: string, opts?: RequestInit) =>
    opts?.method === "POST" ? { ok: true } : path.includes("?platform=") ? { campaigns: campaigns.current } : { campaign: { id, name: "Customer campaign", updated_at: 99 }, campaign_name_prefix: "", currency: "EUR" },
  );
  render(<BoundAdsCampaigns platform="linkedin" />);
  await screen.findByText("Old account campaign");
  expect(listReads()).toBe(1);
  act(() => announceChannelDashboardStale("linkedin_ads"));
  act(() => announceChannelDashboardStale("reddit_ads", "selection"));
  await act(async () => {});
  expect(listReads()).toBe(1);
  campaigns.current = [{ id: "10000000-0000-4000-8000-000000000002", provider_campaign_id: "67890", funding_source: "provider", name: "New account campaign" }];
  act(() => announceChannelDashboardStale("linkedin_ads", "selection"));
  await screen.findByText("New account campaign");
  expect(screen.queryByText("Old account campaign")).toBeNull();
  expect(listReads()).toBe(2);
});
