// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
}));

const approveDecision = vi.fn(async (_id: string, _extras?: Record<string, unknown>) => ({ ok: true }));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: (id: string, extras?: Record<string, unknown>) => approveDecision(id, extras),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

const POST_TITLE = "Upcar for rentals";

const socialPost = {
  id: "post-1",
  decision_class: "social.publish.v2",
  channel_slug: "youtube_organic",
  handler: "social.publish",
  emitted_at: "2026-10-06T10:00:00.000Z",
  run_group: null,
  body: {
    channel: "youtube_video",
    payload: {
      title: POST_TITLE,
      text: "Rent a car from your neighbours",
      video_path: "tenant/3b6acd65.mp4",
      privacy: "public",
    },
  },
};

const recipeStep = {
  id: "step-1",
  decision_class: "channel.recipe_step",
  channel_slug: "youtube_organic",
  handler: null as string | null,
  emitted_at: "2026-10-06T10:00:00.000Z",
  run_group: null,
  body: { step: { title: "Film a 30 second walkthrough of a rental", body: "Show the booking flow." } },
};

let rows: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel="))
      return { ok: true, json: async () => ({ decisions: rows }) };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({ decisions: rows, channel_pending_counts: { youtube_organic: rows.length } }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "youtube_organic",
              delivery_mode: "produce",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-10-06T09:00:00.000Z",
              connected: true,
              connectors: ["composio.youtube"],
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
      .find((b) => b.textContent?.startsWith("YouTube") && /actions? waiting/.test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
}

describe("a staged social post on a read_only channel", () => {
  beforeEach(() => {
    rows = [socialPost];
  });

  it("offers Approve and Reject on the card even though the channel only produces", async () => {
    await expandTheTile();
    expect(await screen.findByRole("button", { name: /^approve$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeTruthy();
  });

  it("opens a drawer with the post preview and Approve, never Did it", async () => {
    await expandTheTile();
    const titles = await screen.findAllByText(POST_TITLE);
    fireEvent.click(titles[0].closest("li")!.querySelector("button")!);
    const dialog = await screen.findByRole("dialog");
    const d = within(dialog);
    expect(d.getByText("Zavi will carry this out as soon as you approve it.")).toBeTruthy();
    expect(d.getByText(POST_TITLE)).toBeTruthy();
    expect(d.getByText("Rent a car from your neighbours")).toBeTruthy();
    expect(d.getByText(/Video attached · 3b6acd65\.mp4/)).toBeTruthy();
    expect(d.queryByRole("button", { name: /did it/i })).toBeNull();
    fireEvent.click(d.getByRole("button", { name: /^approve$/i }));
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledWith("post-1", { expected_scheduled_at: null }));
  });

  it("sends the time the card loaded, so a moved post is refused instead of published", async () => {
    rows = [{ ...socialPost, body: { ...socialPost.body, scheduled_at: "2026-10-07T15:00:00.000Z" } }];
    await expandTheTile();
    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    await vi.waitFor(() =>
      expect(approveDecision).toHaveBeenCalledWith("post-1", { expected_scheduled_at: "2026-10-07T15:00:00.000Z" }),
    );
  });
});

describe("Did it never runs a dispatch handler", () => {
  it("gives a handler-bearing item Approve and Reject instead of a dead Did it", async () => {
    rows = [{ ...recipeStep, handler: "outbound.send" }];
    await expandTheTile();
    fireEvent.click(await screen.findByText(/Film a 30 second walkthrough/));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /did it/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /^approve$/i }));
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledWith("step-1", {}));
  });

  it("still records a handler-less step as done", async () => {
    rows = [recipeStep];
    await expandTheTile();
    fireEvent.click(await screen.findByText(/Film a 30 second walkthrough/));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /did it/i }));
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledWith("step-1", {}));
  });
});
