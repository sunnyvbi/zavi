// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));

vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ rail, id, onApproved, onRejected }: { rail: string; id: string; onApproved?: () => void; onRejected?: () => void }) => (
    <div data-testid="email-card" data-rail={rail} data-id={id}>
      <button type="button" onClick={() => onApproved?.()}>
        Approve and send A
      </button>
      <button type="button" onClick={() => onRejected?.()}>
        Reject
      </button>
    </div>
  ),
}));

const row = {
  id: "email-1",
  decision_class: "bulk_outbound.send",
  channel_slug: "email_marketing",
  handler: "bulk_outbound.send",
  emitted_at: "2026-10-12T10:00:00.000Z",
  run_group: null,
  action_source: "decision",
  thread_id: null,
  body: { list_name: "Newsletter" },
};

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: unknown) => apiFetch(path, init) }));

import { ChannelsPanel, clearChannelBoardCache, EMAIL_CARD_LINGER_MS } from "./ChannelsPanel";

beforeEach(() => {
  clearChannelBoardCache();
  vi.clearAllMocks();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel=")) return { ok: true, json: async () => ({ decisions: [row] }) };
    if (path.startsWith("/api/approvals"))
      return { ok: true, json: async () => ({ decisions: [row], channel_pending_counts: { email_marketing: 1 } }) };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "email_marketing",
              delivery_mode: "execute",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-10-12T09:00:00.000Z",
              connected: true,
              connectors: ["email"],
              linked_connectors: ["email"],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(cleanup);

describe("an email send card on the channels panel", () => {
  it("is the live email card, not a greyed row, and approving it does not crash the panel", async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
      const tile = await vi.waitFor(() => {
        const t = screen
          .getAllByRole("button", { expanded: false })
          .find((b) => b.textContent?.startsWith("Email") && /1 actions? waiting/.test(b.textContent ?? ""));
        if (!t) throw new Error("tile not ready");
        return t;
      });
      fireEvent.click(tile);
      const card = await screen.findByTestId("email-card");
      expect(card.getAttribute("data-id")).toBe("email-1");
      expect(card.closest("fieldset[disabled]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Approve and send A" }));
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("with Details open, the email card is on screen once, so nobody approves from a copy that missed an edit", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const tile = await vi.waitFor(() => {
      const t = screen
        .getAllByRole("button", { expanded: false })
        .find((b) => b.textContent?.startsWith("Email") && /1 actions? waiting/.test(b.textContent ?? ""));
      if (!t) throw new Error("tile not ready");
      return t;
    });
    fireEvent.click(tile);
    await screen.findByTestId("email-card");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await vi.waitFor(() => expect(screen.getAllByTestId("email-card")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByTestId("email-card")).toHaveLength(1);
  });

  it("an approved email card leaves the panel once its sending notice has been seen", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const tile = await vi.waitFor(() => {
      const t = screen
        .getAllByRole("button", { expanded: false })
        .find((b) => b.textContent?.startsWith("Email") && /1 actions? waiting/.test(b.textContent ?? ""));
      if (!t) throw new Error("tile not ready");
      return t;
    });
    fireEvent.click(tile);
    await screen.findByTestId("email-card");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send A" }));
    expect(screen.getByTestId("email-card")).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByTestId("email-card")).toBeNull(), { timeout: EMAIL_CARD_LINGER_MS + 2000 });
  }, EMAIL_CARD_LINGER_MS + 5000);

  it("a rejected email card leaves the panel straight away", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const tile = await vi.waitFor(() => {
      const t = screen
        .getAllByRole("button", { expanded: false })
        .find((b) => b.textContent?.startsWith("Email") && /1 actions? waiting/.test(b.textContent ?? ""));
      if (!t) throw new Error("tile not ready");
      return t;
    });
    fireEvent.click(tile);
    await screen.findByTestId("email-card");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(screen.queryByTestId("email-card")).toBeNull(), { timeout: EMAIL_CARD_LINGER_MS / 3 });
  });
});
