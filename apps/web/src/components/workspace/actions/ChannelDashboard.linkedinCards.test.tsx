// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ role: "owner" as string | null, fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: h.toast, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: h.fetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: h.role }) }));

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const campaign = (id: string, name: string, status: string, group: { id: string; name: string } | null = null, spend = 0) => ({ id, ad_account_id: "9001", currency: "USD", name, status, campaign_group: group, spend, clicks: 0, conversions: 0, cpa: null, url: null });
const group = (id: string, name: string, status: string, over: Partial<{ is_default: boolean; campaign_count: number; total_budget: { amount: number; currency: string } | null; run_end_at: string | null }> = {}) => ({
  id,
  ad_account_id: "9001",
  name,
  status,
  total_budget: null,
  run_end_at: null,
  is_default: false,
  campaign_count: 1,
  ...over,
});
const ad = (id: string, name: string, campaign_id: string, intended_status: string, over: Partial<{ is_serving: boolean | null; review_status: string | null; hold_reasons: string[] }> = {}) => ({
  id,
  campaign_id,
  ad_account_id: "9001",
  name,
  intended_status,
  is_serving: intended_status === "ACTIVE",
  review_status: "APPROVED",
  hold_reasons: [],
  ...over,
});
const SPRING = { id: "g5", name: "Spring launch" };
const payload = {
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  account: { name: "Main", account_count: 1, campaign_count: 3, active_count: 2, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [{ ...campaign("501", "Live", "ACTIVE", SPRING, 40), url: "https://www.linkedin.com/campaignmanager/accounts/9001/campaigns/501" }, campaign("502", "Held", "PAUSED", SPRING, 12), campaign("503", "Solo", "ACTIVE", { id: "g6", name: "Default Campaign Group" })],
  groups: [group("g5", "Spring launch", "ACTIVE", { campaign_count: 2, total_budget: { amount: 500, currency: "USD" }, run_end_at: "2026-12-31T23:59:59.000Z" }), group("g6", "Default Campaign Group", "ACTIVE", { is_default: true }), group("g7", "Winter", "PAUSED", { campaign_count: 0 })],
  ads: [ad("701", "Hero post", "501", "ACTIVE"), ad("702", "Second post", "501", "ACTIVE", { is_serving: false, review_status: "PENDING" }), ad("703", "Only one", "503", "ACTIVE"), ad("704", "Resting", "502", "PAUSED", { is_serving: false, review_status: null })],
};

vi.mock("../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: payload, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: () => {} }),
}));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_ads } from "./platforms/linkedin_ads";
import { linkedinAdsAdsTable, linkedinAdsGroupTable } from "../agent/linkedinAdsTables";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function draw(onActionsChanged = vi.fn()) {
  render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors onActionsChanged={onActionsChanged} />);
  return onActionsChanged;
}

const section = () => document.getElementById("campaigns") as HTMLElement;
const TAB_OF: Record<string, string> = { Campaigns: "Campaigns", Ads: "Ads" };
const pick = (table: string) => {
  const tab = within(section()).getByRole("tab", { name: new RegExp(`^${TAB_OF[table]}$`) });
  if (tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab);
};
const rowIn = (table: string, name: string) => {
  pick(table);
  return within(section()).getByText(name).closest("tr") as HTMLElement;
};
const ACTS = /^(Pause|Restart|Turn off|Turn on)\b/;
const verbOf = (label: string | null) => (label ?? "").replace(/^Ask Zavi to /, "").match(/^(\w+)/)?.[1]?.toLowerCase() ?? "";
const labels = (row: HTMLElement) => [
  ...within(row).queryAllByRole("switch").flatMap((s) => { const m = (s.getAttribute("aria-label") ?? "").match(ACTS); return m ? [m[0]] : []; }),
  ...within(row).queryAllByRole("button").map((b) => b.textContent || `icon:${verbOf(b.getAttribute("aria-label"))}`),
];
const works = (id = "a1") => h.fetch.mockImplementation(async (url: string) => (url.endsWith("/approve") ? json(200, { ok: true }) : json(201, { action_id: id })));
const writes = () => h.fetch.mock.calls.filter((c) => !String(c[0]).includes("/analytics/"));
const filedTo = () => writes().map((c) => c[0] as string).filter((u) => !u.endsWith("/approve"));
const told = () => [...h.toast.mock.calls.map((c: [{ title: string }]) => c[0].title), ...screen.queryAllByRole("alert").map((e) => e.textContent)];

beforeEach(() => {
  h.role = "owner";
  h.fetch.mockReset();
  h.toast.mockReset();
});
afterEach(() => cleanup());

describe("LinkedIn Ads channel page: one tabbed campaigns section and its row controls", () => {
  it("draws one section with Campaigns and Ads tabs, opens on Campaigns, and puts Create campaign beside the tabs", () => {
    draw();
    const tabs = within(section()).getAllByRole("tab").map((t) => [t.textContent, t.getAttribute("aria-selected")]);
    expect(tabs).toEqual([["Campaigns", "true"], ["Ads", "false"]]);
    expect(screen.queryByRole("heading", { name: /^(Campaign groups|Ads)$/ })).toBeNull();
    expect(within(section()).getAllByRole("button", { name: "Create campaign" })).toHaveLength(1);
    expect(within(section()).queryByRole("combobox", { name: "Filter by campaign" })).toBeNull();
    fireEvent.click(within(section()).getByRole("tab", { name: "Ads" }));
    expect(within(section()).getAllByRole("button", { name: "Create ad" })).toHaveLength(1);
    cleanup();
    h.role = "member";
    draw();
    expect(within(section()).queryByRole("button", { name: "Create campaign" })).toBeNull();
  });

  it("the two tabs show all campaigns and all ads without the old campaign filter", () => {
    draw();
    expect(within(section()).getByText("Live")).toBeTruthy();
    expect(within(section()).getByText("Held")).toBeTruthy();
    expect(within(section()).getByText("Solo")).toBeTruthy();
    pick("Ads");
    expect(within(section()).getByText("Hero post")).toBeTruthy();
    expect(within(section()).getByText("Only one")).toBeTruthy();
    expect(within(section()).queryByRole("combobox", { name: "Filter by campaign" })).toBeNull();
  });

  it("the Campaigns tab shows reach, clicks, spend, leads and cost per lead, and the Ads tab names each ad's campaign", () => {
    draw();
    const heads = () => within(section()).getAllByRole("columnheader").map((h) => h.textContent).filter((t) => t !== "Actions");
    expect(heads()).toEqual(["On", "Campaign", "Status", "Daily budget", "Impressions", "Clicks", "Click-through rate", "Spend", "Leads", "Cost per lead"]);
    expect(within(section()).queryByRole("img")).toBeNull();
    expect(section().parentElement?.textContent).toContain("Numbers as reported by LinkedIn Campaign Manager.");
    pick("Ads");
    expect(heads()).toEqual(["On", "Ad", "Campaign", "Status", "Impressions", "Clicks", "Click-through rate", "Spend", "Leads", "Cost per lead"]);
    expect(section().parentElement?.textContent).not.toMatch(/ad set/i);
  });

  it.each(["owner", "admin"])("an %s sees a pause switch on a live campaign and a restart switch on a paused one", (role) => {
    h.role = role;
    draw();
    expect(labels(rowIn("Campaigns", "Live"))).toEqual(["Pause"]);
    const heads = within(section()).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads.slice(0, 3)).toEqual(["On", "Campaign", "Status"]);
    expect(heads.at(-1)).toBe("Actions");
    expect(heads.indexOf("Actions")).toBe(heads.length - 1);
    expect(labels(rowIn("Campaigns", "Held"))).toEqual(["Restart"]);
    expect(within(rowIn("Campaigns", "Live")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(rowIn("Campaigns", "Held")).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("must catch: the On column hugs its switch instead of taking a share of the table width", () => {
    draw();
    const row = rowIn("Campaigns", "Held");
    const first = within(row).getAllByRole("cell")[0];
    expect(first.getAttribute("data-testid")).toBe("linkedin-row-switch");
    expect(first.className.split(" ")).toEqual(expect.arrayContaining(["w-px", "whitespace-nowrap"]));
    const head = within(row.closest("table")!).getAllByRole("columnheader")[0];
    expect(head.textContent).toBe("On");
    expect(head.className.split(" ")).toEqual(expect.arrayContaining(["w-px", "whitespace-nowrap"]));
  });

  it("a campaign with a LinkedIn link gets an Edit button with a pencil in its last cell, opening that campaign in Campaign Manager", () => {
    draw();
    const cells = within(rowIn("Campaigns", "Live")).getAllByRole("cell");
    const edit = within(cells[cells.length - 1]).getByRole("link", { name: /^Edit "Live" in LinkedIn Campaign Manager$/ });
    expect(edit.textContent).toBe("Edit");
    expect(edit.getAttribute("href")).toBe("https://www.linkedin.com/campaignmanager/accounts/9001/campaigns/501");
    expect(edit.getAttribute("target")).toBe("_blank");
    expect(edit.querySelector("svg")).not.toBeNull();
    expect(within(within(rowIn("Campaigns", "Held")).getAllByRole("cell").at(-1)!).queryByRole("link")).toBeNull();
  });

  it.each(["member", "viewer", null])("a %s sees no live control on any tab", (role) => {
    h.role = role;
    draw();
    for (const table of ["Campaigns", "Ads"]) {
      pick(table);
      expect(within(section()).queryByRole("button", { name: /Ask Zavi|^Copy/ })).toBeNull();
      expect(within(section()).queryAllByRole("switch").filter((s) => !(s as HTMLButtonElement).disabled)).toEqual([]);
    }
  });

  it("the Ads table: turn off on ads of a running ad set with another ad on, nothing on the last ad on, turn on for a paused ad, and status chips from the review and hold state", () => {
    draw();
    expect(labels(rowIn("Ads", "Hero post"))).toEqual(["Turn off"]);
    expect(labels(rowIn("Ads", "Second post"))).toEqual(["Turn off"]);
    expect(labels(rowIn("Ads", "Only one"))).toEqual([]);
    const only = within(rowIn("Ads", "Only one")).getByRole("switch") as HTMLButtonElement;
    expect(only.disabled).toBe(true);
    expect(only.getAttribute("aria-checked")).toBe("true");
    expect(labels(rowIn("Ads", "Resting"))).toEqual(["Turn on"]);
    expect(within(rowIn("Ads", "Resting")).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(rowIn("Ads", "Hero post").textContent).toContain("On");
    expect(rowIn("Ads", "Second post").textContent).toContain("In review");
    expect(rowIn("Ads", "Resting").textContent).toContain("Off");
    expect(rowIn("Ads", "Resting").textContent).toContain("Held");
  });

  it("the Ads tab reads each ad's numbers for the page's own window and shows them beside the ad", async () => {
    h.fetch.mockImplementation(async (url: string) => json(200, url.includes("/analytics/ads") ? { rows: [{ id: "701", impressions: 22000, clicks: 198, spend: 620, leads: 14 }] } : {}));
    draw();
    const hero = rowIn("Ads", "Hero post");
    await waitFor(() => expect(hero.textContent).toContain("22,000"));
    expect(hero.textContent).toContain("0.90%");
    expect(hero.textContent).toContain("$44.29");
    expect(h.fetch.mock.calls.filter((c) => String(c[0]).includes("/analytics/ads"))).toHaveLength(1);
  });

  it("turning an ad off files PAUSED for that ad and its campaign and approves it at once; turning on sends ACTIVE", async () => {
    works();
    draw();
    fireEvent.click(within(rowIn("Ads", "Hero post")).getByRole("switch", { name: /^Turn off the ad "Hero post" in LinkedIn now/ }));
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith({ type: "success", title: "Turning this ad off in LinkedIn now." }));
    expect(writes()[0][0]).toBe("/api/channels/linkedin_ads/ads/701/propose-status");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ account_id: "9001", campaign_id: "501", status: "PAUSED" });
    expect(writes()[1][0]).toBe("/api/channel-actions/a1/approve");
    fireEvent.click(within(rowIn("Ads", "Resting")).getByRole("switch", { name: /^Turn on the ad "Resting"/ }));
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith({ type: "success", title: "Turning this ad on in LinkedIn now." }));
    expect(filedTo()).toEqual(["/api/channels/linkedin_ads/ads/701/propose-status", "/api/channels/linkedin_ads/ads/704/propose-status"]);
    expect(JSON.parse(writes()[2][1].body)).toEqual({ account_id: "9001", campaign_id: "502", status: "ACTIVE" });
    expect(writes()).toHaveLength(4);
  });

  it("a 409 shows the server's reason, keeps that switch retryable, and does not refresh as if it worked", async () => {
    const changed = draw();
    h.fetch.mockImplementation(async (url: string) => url.includes("/analytics/") ? json(200, { rows: [] }) : json(409, { error: { code: "linkedin_ads_last_live_ad", message: 'The ad "Hero post" is the only ad that is on in the running campaign "Live".' } }));
    fireEvent.click(within(rowIn("Ads", "Hero post")).getByRole("switch", { name: /^Turn off/ }));
    await waitFor(() => expect(told().at(-1)).toBe('The ad "Hero post" is the only ad that is on in the running campaign "Live".'));
    const hero = within(rowIn("Ads", "Hero post")).getByRole("switch", { name: /^Turn off/ }) as HTMLButtonElement;
    expect(hero.getAttribute("data-retry")).toBe("true");
    expect(hero.disabled).toBe(false);
    expect(hero.getAttribute("aria-checked")).toBe("true");
    expect(changed).not.toHaveBeenCalled();
  });

  it("an archive and a copy on the same row never share a lock, and a second press on either reuses its own call", async () => {
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const calls: Array<[string, Record<string, unknown>]> = [];
    const proposeCard = vi.fn((path: string, body: Record<string, unknown>) => {
      calls.push([path, body]);
      return new Promise<{ action_id: string }>((r) => { if (path.endsWith("propose-status")) releaseA = () => r({ action_id: "s1" }); else releaseB = () => r({ action_id: "d1" }); });
    });
    const approve = vi.fn(async (_id: string) => {});
    const onFiled = vi.fn();
    const [t] = linkedinAdsGroupTable(payload, { canPause: true, proposeCard, approve, onFiled });
    const spring = t.rows.find((r) => r.id === "g5")!;
    const [pause, copy] = spring.actions!;
    const a = pause.onClick!() as Promise<unknown>;
    expect(pause.onClick!()).toBe(a);
    const b = copy.onClick!() as Promise<unknown>;
    expect(b).not.toBe(a);
    expect(calls).toEqual([
      ["groups/g5/propose-status", { account_id: "9001", status: "PAUSED" }],
      ["groups/g5/propose-duplicate", { account_id: "9001" }],
    ]);
    releaseA();
    releaseB();
    await Promise.all([a, b]);
    expect(onFiled).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls.map((c) => c[0]).sort()).toEqual(["d1", "s1"]);
    const [again] = linkedinAdsGroupTable(payload, { canPause: true, proposeCard, approve, onFiled });
    const c = again.rows.find((r) => r.id === "g5")!.actions![0].onClick!() as Promise<unknown>;
    releaseA();
    await c;
    expect(proposeCard).toHaveBeenCalledTimes(3);
  });

  it("an older backend with no groups or ads list draws neither table, and a payload with empty lists draws them empty", () => {
    const { groups: _g, ads: _a, ...older } = payload;
    expect(linkedinAdsGroupTable(older, { canPause: true })).toEqual([]);
    expect(linkedinAdsAdsTable(older, { canPause: true })).toEqual([]);
    const [groups] = linkedinAdsGroupTable({ ...payload, groups: [] }, { canPause: true });
    expect(groups.rows).toEqual([]);
    expect(groups.empty).toMatch(/No campaign group/);
    const [ads] = linkedinAdsAdsTable({ ...payload, ads: [] }, { canPause: true });
    expect(ads.rows).toEqual([]);
    expect(ads.empty).toMatch(/No ad in a running ad set/);
  });
});
