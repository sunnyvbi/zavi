// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/font/local", () => ({ default: () => ({ className: "", style: {} }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
const shell = vi.hoisted(() => ({ approvalsPending: 0 }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: shell.approvalsPending, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ id }: { id: string }) => <div data-testid="email-card" data-id={id} />,
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: unknown) => apiFetch(path, init) }));

import { ChannelsPanel, clearChannelBoardCache, BOARD_EVENT_COALESCE_MS } from "./ChannelsPanel";
import { APPROVALS_CHANGED_EVENT } from "../actions/topActions/api";
import { ATTENTION_CHANGED_EVENT } from "@/lib/workspace/needsYou";

const ID = "b2d1be66-d34b-4d10-a9e2-0322aced83b1";
const row = {
  id: ID,
  decision_class: "bulk_outbound.send",
  channel_slug: "email_marketing",
  handler: "bulk_outbound.send",
  emitted_at: "2026-10-26T10:27:01.000Z",
  run_group: null,
  action_source: "decision",
  thread_id: null,
  status: "proposed",
  body: { list_name: "Newsletter", variants: [{ subject: "Spring menu" }] },
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const paths = () => apiFetch.mock.calls.map(([p]) => String(p));
const boardReads = () => paths().filter((p) => p === "/api/approvals").length;
const channelReads = () => paths().filter((p) => p.startsWith("/api/approvals?channel=email_marketing")).length;
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  clearChannelBoardCache();
  vi.clearAllMocks();
  shell.approvalsPending = 0;
  Element.prototype.scrollIntoView = () => {};
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel=")) return ok({ decisions: [row] });
    if (path.startsWith("/api/approvals")) return ok({ decisions: [row], channel_pending_counts: { email_marketing: 2 } });
    if (path.startsWith("/api/channels/email_marketing/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (path.startsWith("/api/channels"))
      return ok({
        channels: [
          {
            channel_slug: "email_marketing",
            delivery_mode: "execute",
            work_state: "needs_review",
            priority: 1,
            last_run_at: "2026-10-26T09:00:00.000Z",
            connected: true,
            connectors: ["email"],
            linked_connectors: ["email"],
            runnable: true,
          },
        ],
      });
    return ok({});
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const panel = () => <ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />;

describe("one burst of board signals", () => {
  it("a run end, an attention change and a pending-count change read the board once and each open channel once", async () => {
    const view = render(panel());
    const tile = await vi.waitFor(() => {
      const t = screen
        .getAllByRole("button", { expanded: false })
        .find((b) => b.textContent?.startsWith("Email") && /2 actions waiting/.test(b.textContent ?? ""));
      if (!t) throw new Error("tile not ready");
      return t;
    });
    fireEvent.click(tile);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    await vi.waitFor(() => expect(channelReads()).toBeGreaterThanOrEqual(1));
    await wait(BOARD_EVENT_COALESCE_MS * 2);
    const board0 = boardReads();
    const channel0 = channelReads();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(APPROVALS_CHANGED_EVENT));
      window.dispatchEvent(new CustomEvent(ATTENTION_CHANGED_EVENT));
      shell.approvalsPending = 1;
      view.rerender(panel());
      window.dispatchEvent(new CustomEvent(APPROVALS_CHANGED_EVENT));
    });
    expect(boardReads()).toBe(board0);
    expect(channelReads()).toBe(channel0);
    await wait(BOARD_EVENT_COALESCE_MS * 3);
    expect(boardReads() - board0).toBe(1);
    expect(channelReads() - channel0).toBe(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(ATTENTION_CHANGED_EVENT));
    });
    await wait(BOARD_EVENT_COALESCE_MS * 3);
    expect(boardReads() - board0).toBe(2);
    expect(channelReads() - channel0).toBe(2);
  });
});
