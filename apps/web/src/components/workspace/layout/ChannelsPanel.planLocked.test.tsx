// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

const ws = vi.hoisted(() => ({ openTab: vi.fn(), role: "owner" }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    approvalsPending: 0,
    openAgentTab: vi.fn(),
    openTab: ws.openTab,
    tenantName: "Acme Bikes",
    role: ws.role,
  }),
}));

const channelRow = (slug: string, locked_tier: string | null, work_state = "idle") => ({
  channel_slug: slug,
  delivery_mode: "produce",
  work_state,
  priority: 1,
  last_run_at: null,
  connected: false,
  connectors: [],
  runnable: true,
  locked: false,
  locked_tier,
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: [
            {
              id: "d-1",
              decision_class: "channel.recipe_step",
              body: { title: "SECRET ACTION TITLE", summary: "SECRET ACTION BODY" },
              handler: null,
              emitted_at: "2026-09-23T10:00:00Z",
              channel_slug: "seo",
            },
          ],
          channel_pending_counts: { meta_ads: 2, seo: 3, reddit_organic: 1 },
        }),
      };
    if (path.startsWith("/api/channels/seo/actions"))
      return {
        ok: true,
        json: async () => ({
          actions: [],
          more: 0,
          store: "channel_actions",
          locked_preview: { count: 3, types: ["fix", "fix", "page"] },
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            channelRow("meta_ads", "pro"),
            channelRow("sms", "pro"),
            channelRow("seo", "starter"),
            channelRow("reddit_organic", "starter"),
            channelRow("x_organic", "starter", "running"),
          ],
        }),
      };
    return { ok: false, json: async () => ({}) };
  }),
}));

vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/events", async (orig) => ({ ...(await orig<typeof import("@/lib/analytics/events")>()), trackEvent }));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

afterEach(() => {
  cleanup();
  ws.role = "owner";
  ws.openTab.mockClear();
  trackEvent.mockClear();
  vi.useRealTimers();
  window.location.hash = "";
});

describe("ChannelsPanel, a plan-locked channel", () => {
  it("with waiting actions shows just the count, never the content", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("2 actions waiting");
    expect(screen.queryByText(/upgrade to see them/)).toBeNull();
  });

  it("a locked channel whose run is going says Working on it", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const label = await screen.findByText("Working on it");
    const row = label.closest("button") as HTMLButtonElement;
    expect(row.getAttribute("data-channel-slug")).toBe("x_organic");
  });

  it("an owner's click on a locked row goes straight to the plan picker: no preview, no dialog", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("3 actions waiting");
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("SEO").closest("button") as HTMLButtonElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(ws.openTab).toHaveBeenCalledTimes(1);
    expect(ws.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    vi.advanceTimersByTime(10);
    expect(window.location.hash).toBe("#billing-upgrade-starter-6mo");
    expect(document.body.textContent).not.toContain("SECRET");
    expect(trackEvent.mock.calls.filter(([name]) => name === "pricing_plan_selected")).toEqual([
      ["pricing_plan_selected", expect.objectContaining({ tier: "starter", term: "6mo", location: "paywall" })],
    ]);
  });

  it("an owner's click on a locked row with nothing waiting also goes to the plan picker", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("Checks the texting rules for you and writes compliant messages");
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("SMS").closest("button") as HTMLButtonElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ws.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    vi.advanceTimersByTime(10);
    expect(window.location.hash).toBe("#billing-upgrade-pro-6mo");
  });

  it("the upgrade dialog leads with the work, in counts and channel names only", async () => {
    ws.role = "member";
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("3 actions waiting");
    const row = screen.getByText("SEO").closest("button") as HTMLButtonElement;
    fireEvent.click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
    const views = await screen.findAllByRole("button", { name: /^View / });
    expect(views).toHaveLength(3);
    fireEvent.click(views[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("4 actions ready for you")).toBeTruthy();
    expect(within(dialog).getByText("Upgrade to Starter to see them.")).toBeTruthy();
    expect(within(dialog).getByText("Ask a workspace owner or admin to upgrade.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /^See them/ })).toBeNull();
    expect(document.body.textContent).not.toContain("SECRET");
  });

  it("a channel with none of its own still leads with its plan's work", async () => {
    ws.role = "member";
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("2 actions waiting");
    const row = screen.getByText("SMS").closest("button") as HTMLButtonElement;
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 actions ready for you")).toBeTruthy();
    expect(within(dialog).getByText("Upgrade to Pro to see them.")).toBeTruthy();
  });

  it("with nothing waiting shows the channel's one-line description", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("Checks the texting rules for you and writes compliant messages");
    expect(screen.queryByText("Upgrade to run this channel")).toBeNull();
  });
});
