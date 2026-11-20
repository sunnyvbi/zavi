import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/responsive", () => ({ useIsCompact: () => false, useMediaMatch: () => false }));
vi.mock("../navigation/useWorkspaceLocation", () => ({ useWorkspaceLocation: () => "/workspace?tab=channels" }));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => "/workspace?tab=channels",
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => null }));
vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return { ...real, fetchLivePricingClient: async () => real.PRICING_FALLBACK };
});
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const api = vi.hoisted(() => vi.fn());
vi.mock("../actions/managed-campaigns/api", () => ({ campaignFetch: api }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: "owner", tabs: [], activeTabId: null }),
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

const LIVE = "10000000-0000-4000-8000-0000000000aa";
const entry = (slug: string, name: string, lock: ChannelEntry["lock"]): ChannelEntry =>
  ({ channel: { slug, name, connectors: [] }, count: 0, waiting: 0, subtitle: null, lock }) as unknown as ChannelEntry;

const page = (entries: ChannelEntry[]) =>
  render(
    <ChannelsPage entries={entries} loading={false} onShow={() => {}} onUpgrade={() => {}} renderDetail={() => null} currentPlan={null} canComparePlans />,
  );

beforeEach(() => {
  window.localStorage.setItem("zavi:channels-view", "list");
  api.mockReset();
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (path === "/api/ads/campaigns?platform=linkedin")
      return { campaigns: [{ id: LIVE, provider_campaign_id: "777", funding_source: "provider", name: "Spring hiring", status: "ACTIVE" }] };
    if (opts?.method === "POST") return { status: "paused" };
    return {};
  });
});
afterEach(cleanup);

const pauses = () => api.mock.calls.filter(([p, o]) => (o as RequestInit | undefined)?.method === "POST").map(([p]) => String(p));

describe("LinkedIn Ads pause-only safety on the channels page", () => {
  it.each([
    ["Coming soon", { kind: "soon" } as const],
    ["below Pro with no signup-round cards", { kind: "plan", label: "Pro plan", tier: "pro" } as const],
  ])("%s: the founder can still open the live campaign and pause it", async (_label, lock) => {
    page([entry("linkedin_ads", "LinkedIn Ads", lock as ChannelEntry["lock"])]);
    fireEvent.click(await screen.findByRole("button", { name: "Pause LinkedIn Ads campaigns" }));
    const row = screen.getByText("Spring hiring").closest("li") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Review launch" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauses()).toEqual([`/api/ads/campaigns/${LIVE}/pause`]));
  });

  it("an open LinkedIn channel, or one whose page still opens, gets no second campaign list here", async () => {
    page([
      entry("linkedin_ads", "LinkedIn Ads", { kind: "plan", label: "Pro plan", tier: "pro", open: true } as ChannelEntry["lock"]),
    ]);
    await screen.findAllByText("LinkedIn Ads");
    expect(screen.queryByTestId("linkedin-safety")).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });
});
