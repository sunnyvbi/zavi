// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const ws = vi.hoisted(() => ({ openTab: vi.fn(), role: "owner" }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    approvalsPending: 0,
    openAgentTab: vi.fn(),
    openTab: ws.openTab,
    tenantName: "Acme Bikes",
    role: ws.role,
  }),
}));

vi.mock("./ChannelDrawer", async (importOriginal) => {
  const { useChannelPlanLock } = await import("../actions/channelPlanLock");
  const Probe = ({ detail }: { detail: { channel: { slug: string } } | null }) => {
    const lock = useChannelPlanLock();
    if (!detail) return null;
    return (
      <div data-testid="channel-page" data-slug={detail.channel.slug} data-tier={lock?.tierName ?? ""}>
        <button type="button" onClick={() => lock?.upgrade()}>
          page upgrade
        </button>
      </div>
    );
  };
  return { ...(await importOriginal<typeof import("./ChannelDrawer")>()), ChannelDrawer: Probe, ChannelDetailPage: Probe };
});

const channelRow = (slug: string, locked_tier: string | null, first_round_open?: boolean) => ({
  channel_slug: slug,
  delivery_mode: "execute",
  work_state: "delivered",
  priority: 1,
  last_run_at: null,
  connected: false,
  connectors: [],
  runnable: true,
  locked: false,
  locked_tier,
  ...(first_round_open === undefined ? {} : { first_round_open }),
});

const card = (id: string, slug: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  decision_class: "channel.recipe_step",
  body: { step: { title, body: "Why this is worth doing." } },
  handler: null,
  emitted_at: "2026-10-13T10:00:00Z",
  channel_slug: slug,
  action_source: "channel_action",
  ...over,
});

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

function route() {
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: [
            card("ca-1", "seo", "Rewrite the title on the repairs page", { primary_label: "Copy the title" }),
            card("ca-2", "seo", "Pause the old campaign", {
              exec_class: "ads.pause",
              body: { step: { title: "Pause the old campaign", body: "It spent with no result." }, action_label: "Pause" },
            }),
            card("ca-9", "reddit_organic", "SECRET REDDIT CARD"),
          ],
          channel_pending_counts: { seo: 2, reddit_organic: 1 },
        }),
      };
    if (path.startsWith("/api/channels/"))
      return { ok: true, json: async () => ({ actions: [], more: 0, store: "channel_actions", locked_preview: { count: 1, types: ["fix"] } }) };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [channelRow("seo", "starter", true), channelRow("reddit_organic", "starter", false), channelRow("geo", null)],
        }),
      };
    return { ok: false, json: async () => ({}) };
  });
}

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

const posts = () =>
  apiFetch.mock.calls
    .filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST")
    .map((c) => String(c[0]));
const rowOf = (name: string) => screen.getByText(name).closest("button") as HTMLButtonElement;

beforeEach(() => {
  clearChannelBoardCache();
  apiFetch.mockReset();
  route();
});
afterEach(() => {
  cleanup();
  ws.role = "owner";
  ws.openTab.mockClear();
  window.location.hash = "";
});

async function openSeo() {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  await screen.findByText("2 actions waiting");
  fireEvent.click(rowOf("SEO"));
  await screen.findByText("Rewrite the title on the repairs page");
}

describe("ChannelsPanel, a plan-locked channel with first_round_open", () => {
  it("opens on a click and shows its cards: no upgrade, no blurred preview", async () => {
    await openSeo();
    expect(screen.getByText("Pause the old campaign")).toBeTruthy();
    expect(ws.openTab).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
  });

  it("tells the channel page its plan, and the page's upgrade goes to the plan picker", async () => {
    await openSeo();
    fireEvent.click(screen.getByRole("button", { name: "Copy the title" }));
    const page = await screen.findByTestId("channel-page");
    expect(page.getAttribute("data-slug")).toBe("seo");
    expect(page.getAttribute("data-tier")).toBe("Starter");
    fireEvent.click(screen.getByText("page upgrade"));
    expect(ws.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    await waitFor(() => expect(window.location.hash).toBe("#billing-upgrade-starter-6mo"));
  });

  it("a card Zavi would carry out goes to the upgrade and is not approved; Reject still writes", async () => {
    await openSeo();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(ws.openTab).toHaveBeenCalledTimes(1);
    expect(ws.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    expect(posts()).toEqual([]);
    expect(screen.getByText("Pause the old campaign")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(posts()).toEqual(["/api/channel-actions/ca-2"]));
    const body = JSON.parse(String((apiFetch.mock.calls.find((c) => String(c[0]) === "/api/channel-actions/ca-2")![1] as { body: string }).body)) as { action: string };
    expect(body.action).toBe("rejected");
  });

  it("a member gets the upgrade dialog, which does not count the open channel's cards as locked", async () => {
    ws.role = "member";
    await openSeo();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("1 action ready for you");
    expect(posts()).toEqual([]);
  });
});

describe("ChannelsPanel, a plan-locked channel without the flag", () => {
  it("still goes straight to the plan picker and never shows its cards", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("2 actions waiting");
    fireEvent.click(rowOf("Reddit"));
    expect(ws.openTab).toHaveBeenCalledTimes(1);
    expect(ws.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    expect(document.body.textContent).not.toContain("SECRET");
  });

  it("an unlocked channel's page is told there is no lock", async () => {
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await screen.findByText("2 actions waiting");
    fireEvent.click(rowOf("GEO"));
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const page = await screen.findByTestId("channel-page");
    expect(page.getAttribute("data-slug")).toBe("geo");
    expect(page.getAttribute("data-tier")).toBe("");
  });
});
