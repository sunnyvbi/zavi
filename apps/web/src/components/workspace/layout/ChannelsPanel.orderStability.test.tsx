// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
}));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

const h = vi.hoisted(() => ({
  counts: { sms: 3 } as Record<string, number>,
  timeline: [] as string[],
  failApprovalsOnce: false,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    const which = path.startsWith("/api/approvals")
      ? "approvals"
      : path.startsWith("/api/channels")
        ? "channels"
        : "other";
    h.timeline.push(`start:${which}`);
    if (which === "approvals") {
      await new Promise((r) => setTimeout(r, 0));
      h.timeline.push(`resolve:${which}`);
      if (h.failApprovalsOnce) {
        h.failApprovalsOnce = false;
        return { ok: false, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({ decisions: [], channel_pending_counts: { ...h.counts } }),
      };
    }
    if (which === "channels") {
      h.timeline.push(`resolve:${which}`);
      return { ok: true, json: async () => ({ channels: [] }) };
    }
    return { ok: false, json: async () => ({}) };
  }),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

const rowOrder = () =>
  Array.from(document.querySelectorAll("[data-channel-slug]"))
    .map((e) => e.getAttribute("data-channel-slug"))
    .filter((s, i, a) => s && a.indexOf(s) === i) as string[];

beforeEach(() => {
  window.localStorage.clear();
  h.counts = { sms: 3 };
  h.timeline = [];
  h.failApprovalsOnce = false;
});

it("dismisses only the opened channel's notification and keeps its pending work", async () => {
  h.counts = { sms: 3, meta_ads: 4 };
  await mount();
  expect(screen.getByText("3 actions waiting")).toBeTruthy();
  expect(screen.getByText("4 actions waiting")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /SMS/ }));
  await waitFor(() => expect(highlighted()).not.toContain("3 actions waiting"));
  expect(highlighted()).toContain("4 actions waiting");
  expect(screen.getAllByText("3 actions waiting").length).toBeGreaterThan(0);
  expect(screen.getByText("3 actions waiting, not loaded yet.")).toBeTruthy();

  cleanup();
  await mount();
  expect(highlighted()).not.toContain("3 actions waiting");
  expect(highlighted()).toContain("4 actions waiting");
  expect(screen.getAllByText("3 actions waiting").length).toBeGreaterThan(0);
});

const highlighted = () => Array.from(document.querySelectorAll("[data-waiting-highlight]")).map((e) => e.textContent);
afterEach(cleanup);

const mount = async () => {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  await waitFor(() => expect(rowOrder().length).toBeGreaterThan(0));
  await waitFor(() => expect(h.timeline).toContain("resolve:channels"));
};

describe("one paint per load", () => {
  it("starts both reads before either resolves, instead of awaiting in turn", async () => {
    await mount();
    expect(h.timeline.indexOf("start:channels")).toBeGreaterThan(-1);
    expect(h.timeline.indexOf("start:channels")).toBeLessThan(
      h.timeline.indexOf("resolve:approvals"),
    );
  });
});

describe("held order — coming back to the tab does not reshuffle", () => {
  it("keeps the row order it settled on, and still updates the numbers", async () => {
    await mount();
    const before = rowOrder();
    expect(before[0]).toBe("sms");

    h.counts = { sms: 3, meta_ads: 4 };
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(rowOrder()).toEqual(before);
    await waitFor(() =>
      expect(document.body.textContent).toContain("4 actions waiting"),
    );
  });
});

describe("a failed first load must not freeze the order", () => {
  it("waits for a clean read before holding, so recovery can still float work up", async () => {
    h.failApprovalsOnce = true;
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await waitFor(() => expect(rowOrder().length).toBeGreaterThan(0));
    expect(rowOrder()[0]).not.toBe("sms");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => expect(rowOrder()[0]).toBe("sms"));
  });
});
