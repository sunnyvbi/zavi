// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    approvalsPending: 0,
    openAgentTab: vi.fn(),
    openTab: vi.fn(),
  }),
}));

const channelRow = (slug: string, locked: boolean) => ({
  channel_slug: slug,
  delivery_mode: "produce",
  work_state: "idle",
  priority: 1,
  last_run_at: null,
  connected: false,
  connectors: [],
  runnable: true,
  locked,
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: [],
          channel_pending_counts: { meta_ads: 17 },
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [channelRow("meta_ads", true), channelRow("google_ads", false)],
        }),
      };
    return { ok: false, json: async () => ({}) };
  }),
}));

vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

afterEach(cleanup);

describe("ChannelsPanel — a locked channel", () => {
  it("badges the lock AND the work waiting behind it", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("Coming soon · 5+ waiting");
    expect(screen.queryByText("Coming soon")).toBeNull();
  });

  it("never leaks the true count onto the surface", async () => {
    const view = render(
      <ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />,
    );
    await screen.findByText("Coming soon · 5+ waiting");
    expect(view.container.textContent).not.toContain("17");
  });

  it("is aria-disabled and not expandable", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const badge = await screen.findByText("Coming soon · 5+ waiting");
    const tile = badge.closest("button") as HTMLButtonElement;
    expect(tile.textContent).toContain("Meta Ads");
    expect(tile.getAttribute("aria-disabled")).toBe("true");
    expect(tile.hasAttribute("aria-expanded")).toBe(false);

    fireEvent.click(tile);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("an unlocked channel still opens, and carries no badge", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("Coming soon · 5+ waiting");
    expect(screen.getAllByText(/Coming soon/)).toHaveLength(1);
    const google = screen.getByRole("button", { expanded: false, name: /Google Ads/ });
    fireEvent.click(google);
    expect(screen.getByRole("button", { expanded: true, name: /Google Ads/ })).toBeTruthy();
  });
});
