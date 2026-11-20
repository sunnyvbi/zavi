// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/font/local", () => ({ default: () => ({ className: "", style: {} }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));

const h = vi.hoisted(() => ({ scoped: 0, fail: true }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/api/approvals?channel=")) {
      h.scoped += 1;
      if (h.fail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ decisions: [] }) };
    }
    if (path.startsWith("/api/approvals")) {
      return { ok: true, json: async () => ({ decisions: [], channel_pending_counts: { email_marketing: 3 } }) };
    }
    if (path.startsWith("/api/channels/")) return { ok: false, json: async () => ({}) };
    if (path.startsWith("/api/channels")) return { ok: true, json: async () => ({ channels: [{ channel_slug: "email_marketing", delivery_mode: "execute", work_state: "needs_review", priority: 1, last_run_at: "2026-10-26T09:00:00.000Z", connected: true, connectors: ["email"], linked_connectors: ["email"], runnable: true }] }) };
    return { ok: false, json: async () => ({}) };
  }),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";
import { replaceWorkspaceLocation } from "../navigation/workspaceRoutes";

const settle = () => act(() => new Promise((r) => setTimeout(r, 150)));
const mount = () => render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} variant="page" />);

beforeEach(() => {
  clearChannelBoardCache();
  h.scoped = 0;
  h.fail = true;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
});
afterEach(cleanup);

describe("a channel's failed read", () => {
  it("is sent once while the channel stays open", async () => {
    mount();
    await waitFor(() => expect(h.scoped).toBeGreaterThan(0));
    await settle();
    await settle();
    expect(h.scoped).toBe(1);
  });

  it("is sent again when the channel is closed and opened again", async () => {
    mount();
    await waitFor(() => expect(h.scoped).toBe(1));
    await settle();
    act(() => replaceWorkspaceLocation("/workspace?tab=channels"));
    await settle();
    expect(h.scoped).toBe(1);
    act(() => replaceWorkspaceLocation("/workspace?tab=channels&channel=email_marketing"));
    await waitFor(() => expect(h.scoped).toBe(2));
  });
});
