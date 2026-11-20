// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string) =>
    path.startsWith("/api/approvals")
      ? { ok: true, json: async () => ({ decisions: [], channel_pending_counts: {}, run_not_done_counts: {} }) }
      : { ok: true, json: async () => ({ channels: [] }) },
}));
vi.mock("@/lib/workspace/channelActionsApi", () => ({
  setChannelAction: vi.fn(async () => ({})),
  approve: vi.fn(async () => ({})),
  redoChannelAction: vi.fn(async () => ({})),
}));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn(async () => ({ ok: true })) }));
vi.mock("./ChannelsPage", async (orig) => ({ ...(await orig<typeof import("./ChannelsPage")>()), ChannelsPage: () => <div>channels page</div> }));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

afterEach(cleanup);

describe("the Growth Channels page box", () => {
  it("snaps back when a focus or scrollIntoView scrolls it, so the columns never lift and leave a blank band", () => {
    clearChannelBoardCache();
    render(<ChannelsPanel variant="page" collapsed={false} width={380} onToggle={() => {}} />);
    const box = screen.getByRole("complementary", { name: "Growth Channels" });
    box.scrollTop = 374;
    box.scrollLeft = 12;
    fireEvent.scroll(box);
    expect(box.scrollTop).toBe(0);
    expect(box.scrollLeft).toBe(0);
  });
});
