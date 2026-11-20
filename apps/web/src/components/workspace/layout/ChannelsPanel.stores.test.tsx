// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const openTab = vi.fn();
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab }),
  useWorkspaceOptional: () => null,
}));

const TITLE = "Reply to the thread about invoicing in r/smallbusiness";

const card = (
  id: string,
  action_source?: "decision" | "channel_action",
  extra: Record<string, unknown> = {},
) => ({
  id,
  decision_class: "channel.recipe_step",
  channel_slug: "reddit_organic",
  handler: null,
  emitted_at: "2026-09-19T10:00:00.000Z",
  run_group: null,
  ...(action_source ? { action_source } : {}),
  body: { step: { title: TITLE, body: "Answer the question, disclose who you are." } },
  ...extra,
});

let row: ReturnType<typeof card>;
let deliveryMode = "produce";
const apiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
}));

const approveDecision = vi.fn(async (_id: string) => ({ ok: true }));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: (id: string) => approveDecision(id),
}));

const setChannelAction = vi.fn(async (_id: string, _input: { action: string }) => ({}));
const approveChannelAction = vi.fn(async (_id: string) => ({}));
vi.mock("@/lib/workspace/channelActionsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/channelActionsApi")>()),
  setChannelAction: (id: string, input: { action: string }) => setChannelAction(id, input),
  approve: (id: string) => approveChannelAction(id),
  redoChannelAction: vi.fn(async () => ({})),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

beforeEach(() => {
  vi.clearAllMocks();
  deliveryMode = "produce";
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel="))
      return { ok: true, json: async () => ({ decisions: [row] }) };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: row.action_source === "channel_action" ? [] : [row],
          channel_pending_counts: { reddit_organic: 1 },
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "reddit_organic",
              delivery_mode: deliveryMode,
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-09-19T09:00:00.000Z",
              connected: false,
              connectors: [],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(cleanup);

async function expandTheTile() {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const t = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.startsWith("Reddit") && /(^|[^0-9])1 actions? waiting/.test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
  return await screen.findByText(new RegExp(TITLE.slice(0, 25)));
}

async function openTheCard() {
  const title = await expandTheTile();
  fireEvent.click(title);
  return await screen.findByRole("button", { name: /not now/i });
}

const approvalVerbPaths = () =>
  apiFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((p) => /^\/api\/approvals\/[^/]+\/\w+/.test(p));

describe("a channel_actions card writes to the channel_actions store", () => {
  beforeEach(() => {
    row = card("a-1", "channel_action");
  });

  it("Not now goes to the channel-actions route, never to /api/approvals", async () => {
    const notNow = await openTheCard();
    fireEvent.click(notNow);
    await vi.waitFor(() => expect(setChannelAction).toHaveBeenCalled());
    expect(setChannelAction).toHaveBeenCalledWith("a-1", { action: "snoozed" });
    expect(approvalVerbPaths()).toEqual([]);
  });

  it("Did it records acted, and does not call the decisions approve", async () => {
    await openTheCard();
    fireEvent.click(screen.getByRole("button", { name: /did it/i }));
    await vi.waitFor(() => expect(setChannelAction).toHaveBeenCalled());
    expect(setChannelAction).toHaveBeenCalledWith("a-1", { action: "acted" });
    expect(approveDecision).not.toHaveBeenCalled();
  });
});

describe("an executable action cannot be closed without executing", () => {
  beforeEach(() => {
    deliveryMode = "execute";
    row = card("a-exec", "channel_action", { exec_class: "google_ads.set_status" });
  });

  it("this panel closes it no way at all — it offers Review", async () => {
    await expandTheTile();
    fireEvent.click(await screen.findByRole("button", { name: /^review$/i }));
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(approveChannelAction).not.toHaveBeenCalled();
    expect(setChannelAction).not.toHaveBeenCalled();
  });

  it("Reject still writes the plain status, because nothing has to run", async () => {
    await expandTheTile();
    fireEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    await vi.waitFor(() => expect(setChannelAction).toHaveBeenCalledWith("a-exec", { action: "rejected" }));
    expect(approveChannelAction).not.toHaveBeenCalled();
  });

  it("an action with no exec_class writes nothing from the row: it opens the channel", async () => {
    row = card("a-plain", "channel_action", { primary_label: "Copy the reply" });
    await expandTheTile();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Copy the reply" }));
    expect(await screen.findByRole("dialog", { name: /reddit/i })).toBeTruthy();
    expect(setChannelAction).not.toHaveBeenCalled();
    expect(approveChannelAction).not.toHaveBeenCalled();
  });
});

describe("a decisions card is unchanged", () => {
  beforeEach(() => {
    row = card("d-1");
  });

  it("Not now still posts to /api/approvals and never to the new store", async () => {
    const notNow = await openTheCard();
    fireEvent.click(notNow);
    await vi.waitFor(() => expect(approvalVerbPaths()).toContain("/api/approvals/d-1/snooze"));
    expect(setChannelAction).not.toHaveBeenCalled();
  });

  it("Did it still goes through approveDecision", async () => {
    await openTheCard();
    fireEvent.click(screen.getByRole("button", { name: /did it/i }));
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledWith("d-1"));
    expect(setChannelAction).not.toHaveBeenCalled();
  });
});
