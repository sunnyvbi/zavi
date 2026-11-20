// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, tenantId: "tenant-1", openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));

const watch = vi.hoisted(() => ({ resolve: null as null | ((v: unknown) => void), calls: [] as string[] }));
vi.mock("@/lib/workspace/socialPostWatch", () => ({
  watchSocialPost: (id: string) => {
    watch.calls.push(id);
    return new Promise((r) => {
      watch.resolve = r;
    });
  },
}));

const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: toastAdd, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));

const PIN = {
  id: "pin-1",
  decision_class: "social.publish.v2",
  channel_slug: "pinterest_organic",
  handler: "social.publish.v2",
  emitted_at: "2026-10-16T07:09:07.000Z",
  run_group: null,
  action_source: "decision",
  thread_id: null,
  status: "proposed",
  body: { channel: "pinterest_pin", payload: { title: "Cake", text: "ihio", board_name: "Yoga", board_id: "1", link: "https://sweet-layers.example.com" } },
};

let approved = false;
let approvalStatus = 200;
let extra: unknown[] = [];
let hiddenElsewhere = 0;
const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: unknown) => apiFetch(path, init) }));

import { ChannelsPanel, clearChannelBoardCache, PIN_FADE_MS, PIN_POSTED_LINGER_MS } from "./ChannelsPanel";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearChannelBoardCache();
  vi.clearAllMocks();
  approved = false;
  approvalStatus = 200;
  extra = [];
  hiddenElsewhere = 0;
  watch.resolve = null;
  watch.calls = [];
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST" && path === "/api/approvals/pin-1/approve") {
      approved = true;
      return {
        ok: approvalStatus < 400,
        status: approvalStatus,
        json: async () => approvalStatus < 400 ? ({ ok: true }) : ({ error: { message: "Gateway error" } }),
        clone: () => ({ json: async () => ({}) }),
      };
    }
    const decisions = [...(approved ? [] : [PIN]), ...extra];
    if (path.startsWith("/api/approvals?channel=")) return { ok: true, json: async () => ({ decisions }) };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: approved ? [] : [PIN],
          channel_pending_counts: { pinterest_organic: decisions.length + hiddenElsewhere },
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "pinterest_organic",
              delivery_mode: "execute",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-10-16T06:00:00.000Z",
              connected: true,
              connectors: ["composio.pinterest"],
              linked_connectors: ["composio.pinterest"],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(cleanup);

async function openPinterestAndApprove() {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const t = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.startsWith("Pinterest") && /\d+ actions? waiting/.test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
  const approve = await screen.findByRole("button", { name: "Approve" });
  await act(async () => {
    fireEvent.click(approve);
  });
}

describe("approving a Pinterest pin on the channels panel", () => {
  it("resumes a pending pin after the page is reloaded", async () => {
    window.localStorage.setItem(
      "zavi:pending-social-posts:tenant-1",
      JSON.stringify([{ decisionId: "pin-from-last-page", platform: "Pinterest", attempts: 1, expiresAt: Date.now() + 60_000 }]),
    );
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await vi.waitFor(() => expect(watch.calls).toEqual(["pin-from-last-page"]));
    await act(async () => watch.resolve!({ state: "posted", url: null }));
    expect(window.localStorage.getItem("zavi:pending-social-posts:tenant-1")).toBeNull();
  });

  it("keeps the card, shows Posting… while Pinterest answers, then Posted with a popup, then fades it away on its own", async () => {
    await openPinterestAndApprove();
    expect(watch.calls).toEqual(["pin-1"]);
    expect((await screen.findByTestId("pin-posting")).textContent).toBe("Posting to Pinterest…");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("zavi:approvals-changed"));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId("pin-posting")).toBeTruthy();
    await act(async () => {
      watch.resolve!({ state: "posted", url: "https://www.pinterest.com/pin/9/" });
    });
    expect((await screen.findByTestId("pin-posted")).textContent).toContain("Posted to Pinterest");
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Posted to Pinterest" }));
    await new Promise((r) => setTimeout(r, PIN_POSTED_LINGER_MS - 500));
    expect(screen.getByTestId("pin-posted")).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByTestId("pin-posted").closest("li")!.hasAttribute("data-leaving")).toBe(true), { timeout: 1500 });
    await vi.waitFor(() => expect(screen.queryByTestId("pin-posted")).toBeNull(), { timeout: PIN_FADE_MS + 1000 });
    expect(screen.queryByText("New pin · Yoga board")).toBeNull();
  });

  it("retains the posting card when a scoped sidebar refresh removes the approved decision", async () => {
    hiddenElsewhere = 1;
    await openPinterestAndApprove();
    await screen.findByTestId("pin-posting");
    await act(async () => {
      window.dispatchEvent(new Event("zavi:approvals-changed"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByTestId("pin-posting")).toBeTruthy();
    await act(async () => watch.resolve!({ state: "failed", message: "Pinterest did not accept it." }));
    expect((await screen.findByTestId("pin-post-failed")).textContent).toContain("Pinterest did not accept it.");
  });

  it("reconciles the original pin after an ambiguous approval 5xx instead of offering another approval", async () => {
    approvalStatus = 502;
    await openPinterestAndApprove();
    expect(watch.calls).toEqual(["pin-1"]);
    expect(await screen.findByTestId("pin-posting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await act(async () => watch.resolve!({ state: "posted", url: null }));
  });

  it("restores Approve when reconciliation proves the request never took effect", async () => {
    approvalStatus = 502;
    await openPinterestAndApprove();
    await act(async () => watch.resolve!({ state: "approval_uncertain" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByTestId("pin-posting")).toBeNull();
  });

  it("keeps an ambiguous enqueue visibly uncertain instead of claiming nothing was sent", async () => {
    approvalStatus = 502;
    await openPinterestAndApprove();
    await act(async () => watch.resolve!({ state: "uncertain", message: "Check Pinterest before trying again." }));
    expect((await screen.findByTestId("pin-post-failed")).textContent).toBe("Check Pinterest before trying again.");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows a future pin as scheduled without waiting for publication", async () => {
    await openPinterestAndApprove();
    await act(async () => watch.resolve!({ state: "scheduled", scheduledAt: "2099-01-02T09:30:00.000Z" }));
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Scheduled for Pinterest" }));
    expect(screen.queryByTestId("pin-posting")).toBeNull();
    expect(screen.queryByText("New pin · Yoga board")).toBeNull();
  });

  it("applies a resumed follow-up result to a retained slow card", async () => {
    await openPinterestAndApprove();
    await screen.findByTestId("pin-posting");
    await act(async () => watch.resolve!({ state: "slow" }));
    expect((await screen.findByTestId("pin-post-failed")).textContent).toContain("Still posting");

    await act(async () => window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() => expect(watch.calls).toEqual(["pin-1", "pin-1"]));
    await act(async () => watch.resolve!({ state: "posted", url: "https://www.pinterest.com/pin/10/" }));

    expect((await screen.findByTestId("pin-posted")).textContent).toContain("Posted to Pinterest");
  });

  it("starts the same durable posting follow-up when Approve is pressed in the detail drawer", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const tile = await vi.waitFor(() =>
      screen.getAllByRole("button", { expanded: false }).find((button) => button.textContent?.startsWith("Pinterest"))!,
    );
    fireEvent.click(tile);
    fireEvent.click(await screen.findByText("New pin"));
    const drawer = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "Approve" }));
    });
    expect(watch.calls).toEqual(["pin-1"]);
    expect(await screen.findByTestId("pin-posting")).toBeTruthy();
    await act(async () => watch.resolve!({ state: "posted", url: null }));
  });

  it("a refused post stays on the card with the reason and an error popup, never a silent disappearance", async () => {
    await openPinterestAndApprove();
    await screen.findByTestId("pin-posting");
    await act(async () => {
      watch.resolve!({ state: "failed", message: "Pinterest did not accept it. Board not found." });
    });
    expect((await screen.findByTestId("pin-post-failed")).textContent).toBe("Couldn't post: Pinterest did not accept it. Board not found.");
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Couldn't post to Pinterest" }));
  });

  it("a pin staged from the dialog shows on the open channel at once, without reopening it", async () => {
    hiddenElsewhere = 1;
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    const tile = await vi.waitFor(() => {
      const t = screen
        .getAllByRole("button", { expanded: false })
        .find((b) => b.textContent?.startsWith("Pinterest") && /2 actions? waiting/.test(b.textContent ?? ""));
      if (!t) throw new Error("tile not ready: " + screen.queryAllByRole("button").map((b) => b.textContent ?? "").filter((x) => x.includes("Pinterest")).join(" | "));
      return t;
    });
    fireEvent.click(tile);
    await screen.findByRole("button", { name: "Approve" });
    await vi.waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/approvals?channel=pinterest_organic"))).toBe(true));
    extra = [{ ...PIN, id: "pin-2", emitted_at: "2026-10-16T07:36:12.000Z", body: { ...PIN.body, payload: { ...PIN.body.payload, title: "Fresh pin", board_name: "Profile" } } }];
    await act(async () => {
      window.dispatchEvent(new Event("zavi:approvals-changed"));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await screen.findByText("Fresh pin")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
  });
});
