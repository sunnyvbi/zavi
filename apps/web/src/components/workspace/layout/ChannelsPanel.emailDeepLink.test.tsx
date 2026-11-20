// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/font/local", () => ({ default: () => ({ className: "", style: {} }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));

vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ rail, id }: { rail: string; id: string }) => (
    <div data-testid="email-card" data-rail={rail} data-id={id}>
      Fresh from the oven this week
    </div>
  ),
}));

const FIRST = "b2d1be66-d34b-4d10-a9e2-0322aced83b1";
const LINKED = "72c3a6ac-8550-40e9-8db6-340938d56a8a";
const OTHER = "30d4eb1a-b15b-4be3-bd32-ebed7bfd835d";

const decision = (id: string, emitted_at: string, subject: string) => ({
  id,
  decision_class: "bulk_outbound.send",
  channel_slug: "email_marketing",
  handler: "bulk_outbound.send",
  emitted_at,
  run_group: null,
  action_source: "decision",
  thread_id: null,
  status: "proposed",
  body: { list_name: "Newsletter", variants: [{ subject }] },
});

const rows = [
  decision(LINKED, "2026-10-26T12:07:40.000Z", "Fresh from the oven this week"),
  decision(FIRST, "2026-10-26T10:27:01.000Z", "Fresh from the oven this week"),
  decision(OTHER, "2026-10-26T10:13:14.000Z", "QA Flow 18 spring menu"),
];

const laneAction = makeAction("fix", { id: "ca-winback", channel_slug: "email_marketing", title: "Win back 214 lapsed customers" });

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: unknown) => apiFetch(path, init) }));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";
import { makeAction } from "../actions/__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const scrollIntoView = vi.fn();

beforeEach(() => {
  clearChannelBoardCache();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = scrollIntoView;
  window.history.replaceState(null, "", `/workspace?tab=channels&channel=email_marketing&action=${LINKED}`);
  apiFetch.mockImplementation(async (path: string) => {
    if (path === `/api/approvals/${LINKED}`)
      return ok({ decision: rows[0], home: { kind: "channel", slug: "email_marketing" }, needs_owner_admin: false, viewer_role: "owner" });
    if (path.startsWith("/api/approvals?channel=")) return ok({ decisions: rows });
    if (path.startsWith("/api/approvals")) return ok({ decisions: rows, channel_pending_counts: { email_marketing: 3 } });
    if (path.startsWith("/api/channels/email_marketing/actions")) return ok({ actions: [laneAction], more: 0, store: "channel_actions" });
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

describe("?action=<decision id> on Email campaigns", () => {
  it("scrolls to and flashes the linked email card, not its same-subject twin, and draws no second copy", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const tile = await vi.waitFor(() => {
      const t = screen
        .getAllByRole("button", { expanded: false })
        .find((b) => b.textContent?.startsWith("Email") && /3 actions? waiting/.test(b.textContent ?? ""));
      if (!t) throw new Error("tile not ready");
      return t;
    });
    fireEvent.click(tile);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    await vi.waitFor(() => expect(screen.getAllByTestId("email-card").length).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() => expect(apiFetch.mock.calls.some(([u]) => u === `/api/approvals/${LINKED}`)).toBe(true));
    const target = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="action-${LINKED}"]`);
      if (!el) throw new Error("no deep-link target for the linked decision");
      return el;
    });
    expect(target.querySelector("[data-testid='email-card']")?.getAttribute("data-id")).toBe(LINKED);
    expect(target.closest("[data-testid='chat-staged']")).not.toBeNull();
    expect(screen.getAllByText("Win back 214 lapsed customers").length).toBeGreaterThan(0);
    expect(target.querySelector("[data-testid='email-card']")?.getAttribute("data-rail")).toBe("decisions");
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.instances.every((el) => el === target)).toBe(true);
    expect(target.className).toContain("shadow-[0_0_36px_rgba(255,255,255,0.32)]");
    const twin = document.querySelector<HTMLElement>(`[data-testid="action-${FIRST}"]`);
    expect(twin?.className ?? "").not.toContain("shadow-[0_0_36px_rgba(255,255,255,0.32)]");
    expect(screen.queryByTestId("linked-decision")).toBeNull();
    expect(screen.getAllByTestId("email-card").filter((c) => c.getAttribute("data-id") === LINKED)).toHaveLength(1);
  });
});
