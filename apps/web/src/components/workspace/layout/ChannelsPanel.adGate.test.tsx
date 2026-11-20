// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const openAgentTab = vi.fn();
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab, openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));

const TITLE = "Raise the daily budget on Brand Search";

let channelSlug = "google_ads";
let channelName = "Google Ads";
let deliveryMode = "execute";

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  decision_class: "channel.recipe_step",
  channel_slug: channelSlug,
  handler: null,
  emitted_at: "2026-09-19T10:00:00.000Z",
  run_group: null,
  action_source: "channel_action" as const,
  body: {
    step: { title: TITLE, body: "Brand Search is capped out before noon." },
    decision_evidence: { blast_radius: "YELLOW", reversibility: "reversible" },
  },
  ...extra,
});

let row: Record<string, unknown>;
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
  channelSlug = "google_ads";
  channelName = "Google Ads";
  deliveryMode = "execute";
  row = card("a-budget", { exec_class: "google_ads.update_campaign_budget" });
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel="))
      return { ok: true, json: async () => ({ decisions: [row] }) };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: row.action_source === "channel_action" ? [] : [row],
          channel_pending_counts: { [channelSlug]: 1 },
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: channelSlug,
              delivery_mode: deliveryMode,
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-09-19T09:00:00.000Z",
              connected: true,
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

async function expandTheTile(primary: RegExp = /^(review|approve)$/i) {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const t = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.startsWith(channelName) && /(^|[^0-9])1 actions? waiting/.test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
  return await screen.findByRole("button", { name: primary });
}

const wroteNothing = () => {
  expect(approveChannelAction).not.toHaveBeenCalled();
  expect(setChannelAction).not.toHaveBeenCalled();
  expect(approveDecision).not.toHaveBeenCalled();
  expect(
    apiFetch.mock.calls.map((c) => String(c[0])).filter((p) => /^\/api\/approvals\/[^/]+\//.test(p)),
  ).toEqual([]);
};

describe("an executable ad card is gated, not one-click", () => {
  it("the card offers Review, never Approve", async () => {
    await expandTheTile();
    expect(await screen.findByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });

  it("clicking Review changes nothing on the ad account", async () => {
    await expandTheTile();
    fireEvent.click(await screen.findByRole("button", { name: /^review$/i }));
    await vi.waitFor(() => expect(openAgentTab).toHaveBeenCalled());
    wroteNothing();
  });

  it("the drawer offers Review too, so there is no one-click approve anywhere here", async () => {
    await expandTheTile();
    expect(screen.getAllByRole("button", { name: /^review$/i })).toHaveLength(1);
    fireEvent.click(screen.getByText(new RegExp(TITLE.slice(0, 20))));
    await screen.findByRole("button", { name: /see how zavi got here/i });
    expect(screen.getAllByRole("button", { name: /^review$/i })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });

  it("holds on Meta too — the gate is the class, not the one channel", async () => {
    channelSlug = "meta_ads";
    channelName = "Meta Ads";
    row = card("a-meta", { exec_class: "meta_ads.update_ad_set_budget_review" });
    await expandTheTile();
    expect(await screen.findByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });
});

describe("the gate does not swallow the rest of the queue", () => {
  it("a channel action with no exec_class is one click, to its own card", async () => {
    row = { ...card("a-plain"), primary_label: "Open settings" };
    fireEvent.click(await expandTheTile(/^Open settings$/));
    expect(screen.queryByRole("button", { name: /^(review|approve)$/i })).toBeNull();
    expect(setChannelAction).not.toHaveBeenCalled();
    expect(approveChannelAction).not.toHaveBeenCalled();
  });

  it("a decisions-rail ad change gates exactly as it did before", async () => {
    row = {
      ...card("d-budget"),
      decision_class: "google_ads.update_campaign_budget",
      action_source: undefined,
    };
    await expandTheTile();
    expect(await screen.findByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });
});
