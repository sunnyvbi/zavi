// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
}));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

const h = vi.hoisted(() => ({
  gate: null as null | Promise<void>,
  open: () => {},
  counts: { sms: 3 } as Record<string, number>,
  approvalReads: 0,
  clearers: [] as Array<() => void>,
}));

vi.mock("@/lib/workspace/sessionScopedCache", () => ({
  registerSessionScopedCache: (clear: () => void) => {
    if (!h.clearers.includes(clear)) h.clearers.push(clear);
  },
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/api/approvals")) {
      h.approvalReads += 1;
      if (h.gate) await h.gate;
      return { ok: true, json: async () => ({ decisions: [], channel_pending_counts: { ...h.counts } }) };
    }
    if (path.startsWith("/api/channels")) {
      if (h.gate) await h.gate;
      return { ok: true, json: async () => ({ channels: [] }) };
    }
    return { ok: false, json: async () => ({}) };
  }),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

const hold = () => {
  h.gate = new Promise<void>((resolve) => {
    h.open = () => {
      h.gate = null;
      resolve();
    };
  });
};

const smsRow = () => document.querySelector('[data-channel-slug="sms"]') as HTMLElement | null;
const status = (row: HTMLElement | null) => row?.querySelector("[data-row-status]") as HTMLElement | null;

beforeEach(() => {
  clearChannelBoardCache();
  h.gate = null;
  h.counts = { sms: 3 };
  h.approvalReads = 0;
  h.clearers = [];
  window.localStorage.clear();
});
afterEach(() => {
  h.open();
  cleanup();
});

const mount = () => render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);

describe("channel rows while the board loads", () => {
  it("paints every row at once with no skeleton bar, then fades the status in", async () => {
    hold();
    mount();
    await waitFor(() => expect(smsRow()).toBeTruthy());
    const rows = Array.from(document.querySelectorAll("[data-channel-slug]"));
    expect(rows.length).toBeGreaterThan(3);
    expect(document.querySelectorAll("[data-channel-slug] .animate-pulse")).toHaveLength(0);
    expect(status(smsRow())).toBeNull();
    expect((smsRow() as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      h.open();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(status(smsRow())?.textContent).toBe("3 actions waiting"));
    expect(status(smsRow())!.className).toContain("motion-safe:animate-fade-in");
  });

  it("a revisit paints the last known status on the first frame, without a fade", async () => {
    mount();
    await waitFor(() => expect(status(smsRow())?.textContent).toBe("3 actions waiting"));
    cleanup();

    hold();
    h.counts = { sms: 5 };
    mount();
    expect(status(smsRow())?.textContent).toBe("3 actions waiting");
    expect(status(smsRow())!.className).not.toContain("animate-fade-in");
    expect(document.querySelectorAll("[data-channel-slug] .animate-pulse")).toHaveLength(0);

    await act(async () => {
      h.open();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(status(smsRow())?.textContent).toBe("5 actions waiting"));
    expect(h.approvalReads).toBe(2);
  });

  it("signing out drops the cached board, so the next person never sees it", async () => {
    mount();
    await waitFor(() => expect(status(smsRow())?.textContent).toBe("3 actions waiting"));
    cleanup();
    expect(h.clearers).toContain(clearChannelBoardCache);
    h.clearers.forEach((clear) => clear());

    hold();
    mount();
    await waitFor(() => expect(smsRow()).toBeTruthy());
    expect(status(smsRow())).toBeNull();
    expect(screen.queryByText("3 actions waiting")).toBeNull();
  });

  it("a failed board read is never cached as an empty board", async () => {
    mount();
    await waitFor(() => expect(status(smsRow())?.textContent).toBe("3 actions waiting"));
    cleanup();
    clearChannelBoardCache();

    const api = (await import("@/lib/api")).apiFetch as unknown as ReturnType<typeof vi.fn>;
    api.mockImplementationOnce(async () => ({ ok: false, json: async () => ({}) }));
    mount();
    await waitFor(() => expect(smsRow()).toBeTruthy());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    cleanup();

    hold();
    mount();
    expect(status(smsRow())).toBeNull();
    expect(screen.getByText("Loading pending actions…").getAttribute("aria-busy")).toBe("true");
  });
});
