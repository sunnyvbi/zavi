// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  role: "owner" as string | null,
  fetch: vi.fn(),
  release: null as null | ((r: Response) => void),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: h.toast, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: h.fetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: h.role }) }));

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = {
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  account: { name: "Main", account_count: 1, campaign_count: 3, active_count: 1, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [
    { id: "501", ad_account_id: "9001", currency: "USD", name: "Live", status: "ACTIVE", spend: 0, clicks: 0, conversions: 0, cpa: null, url: null },
    { id: "502", ad_account_id: "9001", currency: "USD", name: "Held", status: "PAUSED", spend: 0, clicks: 0, conversions: 0, cpa: null, url: null },
    { id: "503", ad_account_id: "9001", currency: "USD", name: "Spring draft", status: "DRAFT", spend: 0, clicks: 0, conversions: 0, cpa: null, url: null },
  ],
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
  render(
    <ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors onActionsChanged={onActionsChanged} />,
  );
  return onActionsChanged;
}

const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

beforeEach(() => {
  h.role = "owner";
  h.fetch.mockReset();
  h.toast.mockReset();
});
afterEach(() => cleanup());

describe("LinkedIn Ads ad set rows: the on/off switch pauses in one click", () => {
  it.each(["owner", "admin"])("an %s sees the pause switch on, and only on, the ACTIVE campaign", (role) => {
    h.role = role;
    draw();
    const live = within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live" in LinkedIn now\./ });
    expect(live.getAttribute("aria-checked")).toBe("true");
    expect(within(rowOf("Held")).queryByRole("switch", { name: /^Pause/ })).toBeNull();
    expect(within(rowOf("Spring draft")).queryByRole("switch", { name: /^(Pause|Restart)/ })).toBeNull();
    expect(screen.getAllByRole("switch", { name: /^Pause/ })).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: /Next steps|Ask Zavi/ })).toBeNull();
  });

  it.each(["member", "viewer", null])("a %s sees the state but no live switch, and is told who can", (role) => {
    h.role = role;
    draw();
    expect(screen.queryByRole("switch", { name: /^Pause/ })).toBeNull();
    const live = within(rowOf("Live")).getByRole("switch") as HTMLButtonElement;
    expect(live.disabled).toBe(true);
    expect(live.getAttribute("aria-checked")).toBe("true");
    expect(live.getAttribute("aria-label")).toMatch(/Only an owner or admin/);
  });

  it("one press files the pause and approves that same card at once, so nothing is left in Next steps, and the switch flips off", async () => {
    let releaseFile: (r: Response) => void = () => {};
    let releaseApprove: (r: Response) => void = () => {};
    h.fetch
      .mockImplementationOnce(() => new Promise<Response>((r) => { releaseFile = r; }))
      .mockImplementationOnce(() => new Promise<Response>((r) => { releaseApprove = r; }));
    const changed = draw();
    const button = within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Pausing…");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe("/api/channels/linkedin_ads/campaigns/501/propose-pause");
    expect(JSON.parse(init.body)).toEqual({ account_id: "9001" });
    await act(async () => { releaseFile(json(201, { action_id: "a1", campaign: { id: "501", name: "Live" } })); });
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    const [approveUrl, approveInit] = h.fetch.mock.calls[1];
    expect(approveUrl).toBe("/api/channel-actions/a1/approve");
    expect(approveInit.method).toBe("POST");
    expect(JSON.parse(approveInit.body)).toEqual({ request_id: "row:a1" });
    expect(changed).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
    await act(async () => { releaseApprove(json(200, { ok: true })); });
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ type: "success", title: "Pausing this campaign in LinkedIn now." }));
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    const after = within(rowOf("Live")).getByRole("switch") as HTMLButtonElement;
    expect(after.getAttribute("aria-checked")).toBe("false");
    expect(after.disabled).toBe(true);
    expect(after.getAttribute("aria-label")).toBe('"Live" is pausing in LinkedIn.');
    fireEvent.click(after);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("no hint or toast sends the founder to Next steps when it worked", async () => {
    h.fetch.mockResolvedValueOnce(json(201, { action_id: "a1" })).mockResolvedValueOnce(json(200, {}));
    draw();
    const button = within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ });
    expect(button.getAttribute("title")).not.toMatch(/Next steps|approve/i);
    fireEvent.click(button);
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast.mock.calls[0][0].title).not.toMatch(/Next steps|filed|approve/i);
  });

  it("a refused approve says why and that the card waits in Next steps, refreshes so that card shows, and leaves the switch on to try again", async () => {
    h.fetch
      .mockResolvedValueOnce(json(201, { action_id: "a1" }))
      .mockResolvedValueOnce(json(403, { error: { code: "plan_locked", message: "LinkedIn Ads is on the Pro plan." } }));
    const changed = draw();
    fireEvent.click(within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ type: "error", title: "LinkedIn Ads is on the Pro plan. It is waiting in Next steps." }));
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    const again = within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }) as HTMLButtonElement;
    expect(again.getAttribute("data-retry")).toBe("true");
    expect(again.title).toMatch(/Try again\.$/);
    expect(again.disabled).toBe(false);
    expect(again.getAttribute("aria-checked")).toBe("true");
  });

  it("a refused filing shows the server's reason, never calls approve, and does not refresh as if it worked", async () => {
    h.fetch.mockResolvedValueOnce(json(409, { error: { code: "linkedin_ads_pause_pending", message: "A pause for this campaign is already waiting in Next steps. Approve or dismiss that one." } }));
    const changed = draw();
    fireEvent.click(within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ type: "error", title: "A pause for this campaign is already waiting in Next steps. Approve or dismiss that one." }));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("a filing that returns no card id is reported, never approved blindly", async () => {
    h.fetch.mockResolvedValueOnce(json(201, { campaign: { id: "501" } }));
    draw();
    fireEvent.click(within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ type: "error", title: "Zavi couldn't start the change. It is waiting in Next steps." }));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("a network failure and an unreadable error body still read as plain words", async () => {
    h.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
    draw();
    const button = within(rowOf("Live")).getByRole("switch", { name: /^Pause "Live"/ });
    fireEvent.click(button);
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith({ type: "error", title: "Couldn't reach Zavi. Check your connection." }));
    fireEvent.click(button);
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith({ type: "error", title: "Zavi couldn't make the pause. Try again in a moment." }));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("two presses that reach the handler before a re-render still file and approve once, and a press after it settles runs again", async () => {
    let release: () => void = () => {};
    const propose = vi.fn(() => new Promise<{ action_id: string }>((r) => { release = () => r({ action_id: "a1" }); }));
    const approve = vi.fn(async () => {});
    const onFiled = vi.fn();
    const [t] = linkedinAdsCampaignTable(payload, { canPause: true, propose, approve, onFiled });
    const action = t.rows[0].actions![0];
    const first = action.onClick!() as Promise<unknown>;
    const second = action.onClick!() as Promise<unknown>;
    expect(second).toBe(first);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith("501", "9001");
    release();
    await first;
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith("a1");
    expect(onFiled).toHaveBeenCalledTimes(1);
    const [again] = linkedinAdsCampaignTable(payload, { canPause: true, propose, approve, onFiled });
    const third = again.rows[0].actions![0].onClick!() as Promise<unknown>;
    release();
    await third;
    expect(propose).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it("a campaign with no ad account id gets no button, since the server could not re-read it", () => {
    const [t] = linkedinAdsCampaignTable({ ...payload, campaigns: [{ ...payload.campaigns[0], ad_account_id: undefined }] }, { canPause: true });
    expect(t.rows[0].actions).toBeUndefined();
  });
});

describe("LinkedIn Ads snapshot on a phone", () => {
  it("keeps a top gap between the fit line above and the first tile", () => {
    const { container } = render(
      <ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />,
    );
    const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/);
    const phone = classes.filter((c) => /^compact:mt-/.test(c));
    expect(phone).toHaveLength(1);
    expect(phone[0]).not.toBe("compact:mt-0");
    expect(classes).toContain("mt-5");
  });
});
