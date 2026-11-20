// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ role: "owner" as string | null, fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: h.toast, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: h.fetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: h.role }) }));

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const campaign = (id: string, name: string, status: string) => ({ id, ad_account_id: "9001", currency: "USD", name, status, spend: 0, clicks: 0, conversions: 0, cpa: null, url: null });
const payload = {
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  account: { name: "Main", account_count: 1, campaign_count: 5, active_count: 1, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [campaign("501", "Live", "ACTIVE"), campaign("502", "Held", "PAUSED"), campaign("503", "Over", "COMPLETED"), campaign("504", "Spring draft", "DRAFT"), campaign("505", "Gone", "ARCHIVED")],
};

vi.mock("../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: payload, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: () => {} }),
}));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_ads } from "./platforms/linkedin_ads";
import { linkedinAdsCampaignTable } from "../agent/linkedinAdsTables";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function draw(onActionsChanged = vi.fn()) {
  render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors onActionsChanged={onActionsChanged} />);
  return onActionsChanged;
}

const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const told = () => [...h.toast.mock.calls.map((c: [{ title: string }]) => c[0].title), ...screen.queryAllByRole("alert").map((e) => e.textContent)];

beforeEach(() => {
  h.role = "owner";
  h.fetch.mockReset();
  h.toast.mockReset();
});
afterEach(() => cleanup());

describe("LinkedIn Ads ad set rows: the on/off switch restarts in one click", () => {
  it.each(["owner", "admin"])("an %s sees restart on the paused and the completed campaign, pause on the live one, nothing on a draft or an archived one", (role) => {
    h.role = role;
    draw();
    expect(within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }).getAttribute("aria-checked")).toBe("true");
    const held = within(rowOf("Held")).getByRole("switch", { name: /^Restart "Held" in LinkedIn now\. It starts spending again\.$/ });
    expect(held.getAttribute("aria-checked")).toBe("false");
    expect(within(rowOf("Over")).getByRole("switch", { name: /^Restart "Over" in LinkedIn now for another 30 days\./ }).getAttribute("aria-checked")).toBe("false");
    expect(within(rowOf("Spring draft")).queryByRole("switch", { name: /^(Pause|Restart)/ })).toBeNull();
    expect(within(rowOf("Gone")).queryByRole("button")).toBeNull();
    expect(within(rowOf("Gone")).queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("switch", { name: /^Restart/ })).toHaveLength(2);
  });

  it.each(["member", "viewer", null])("a %s sees no live restart switch", (role) => {
    h.role = role;
    draw();
    expect(screen.queryByRole("switch", { name: /^Restart/ })).toBeNull();
  });

  it("one press files the restart and approves it straight away, then the switch flips on and the list refreshes", async () => {
    let release: (r: Response) => void = () => {};
    h.fetch
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const changed = draw();
    const button = within(rowOf("Held")).getByRole("switch", { name: /^Restart "Held"/ }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.title).toBe("Restarting…");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe("/api/channels/linkedin_ads/campaigns/502/propose-resume");
    expect(JSON.parse(init.body)).toEqual({ account_id: "9001" });
    await act(async () => { release(json(201, { action_id: "r1", campaign: { id: "502", name: "Held", was: "PAUSED", run_until: null } })); });
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ type: "success", title: "Restarting this campaign in LinkedIn now." }));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[1][0]).toBe("/api/channel-actions/r1/approve");
    expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({ request_id: "row:r1" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(within(rowOf("Held")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(rowOf("Over")).getByRole("switch", { name: /^Restart "Over"/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("a refused filing shows the server's reason, never approves, and does not refresh as if it worked", async () => {
    h.fetch.mockResolvedValueOnce(json(409, { error: { code: "linkedin_ads_resume_pending", message: "A restart for this campaign is already waiting in Next steps. Approve or dismiss that one." } }));
    const changed = draw();
    fireEvent.click(within(rowOf("Over")).getByRole("switch", { name: /^Restart "Over"/ }));
    await waitFor(() => expect(told()).toEqual(["A restart for this campaign is already waiting in Next steps. Approve or dismiss that one."]));
    expect(within(rowOf("Over")).getByRole("switch", { name: /^Restart "Over"/ }).getAttribute("data-retry")).toBe("true");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it("a network failure and an unreadable error body still read as plain words, naming the restart", async () => {
    h.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
    draw();
    const button = within(rowOf("Held")).getByRole("switch", { name: /^Restart "Held"/ });
    fireEvent.click(button);
    await waitFor(() => expect(told().at(-1)).toBe("Couldn't reach Zavi. Check your connection."));
    fireEvent.click(button);
    await waitFor(() => expect(told().at(-1)).toBe("Zavi couldn't make the restart. Try again in a moment."));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("a pause and a restart in flight on different rows never share a lock, and a second press on the same row reuses the first call", async () => {
    let releasePause: () => void = () => {};
    let releaseResume: () => void = () => {};
    const propose = vi.fn(() => new Promise<{ action_id: string }>((r) => { releasePause = () => r({ action_id: "p1" }); }));
    const proposeResume = vi.fn(() => new Promise<{ action_id: string }>((r) => { releaseResume = () => r({ action_id: "r1" }); }));
    const approve = vi.fn(async (_id: string) => {});
    const onFiled = vi.fn();
    const [t] = linkedinAdsCampaignTable(payload, { canPause: true, propose, proposeResume, approve, onFiled });
    const live = t.rows[0].actions![0];
    const held = t.rows[1].actions![0];
    expect(live.label).toBe("Pause");
    expect(held.label).toBe("Restart");
    const a = held.onClick!() as Promise<unknown>;
    expect(held.onClick!()).toBe(a);
    const b = live.onClick!() as Promise<unknown>;
    expect(b).not.toBe(a);
    expect(proposeResume).toHaveBeenCalledWith("502", "9001");
    expect(propose).toHaveBeenCalledWith("501", "9001");
    releasePause();
    releaseResume();
    await Promise.all([a, b]);
    expect(approve.mock.calls.map((c) => c[0]).sort()).toEqual(["p1", "r1"]);
    expect(onFiled).toHaveBeenCalledTimes(2);
  });

  it("a paused campaign with no ad account id gets no button", () => {
    const [t] = linkedinAdsCampaignTable({ ...payload, campaigns: [{ ...payload.campaigns[1], ad_account_id: undefined }] }, { canPause: true });
    expect(t.rows[0].actions).toBeUndefined();
  });
});
