
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    openTab: () => "",
    openAgentTab: async () => "",
    activeTabId: "",
    tabs: [],
    tenantName: "TestCo",
    userEmail: "test@example.com",
    refreshTree: async () => {},
  }),
}));
vi.mock("../useAgentPins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../useAgentPins")>()),
  useAgentPins: () => ({ pins: [], isPinned: () => false, togglePin: () => {} }),
}));
vi.mock("../useCompetitorIntel", () => ({
  useCompetitorIntel: () => ({ data: { enabled: false } }),
}));
vi.mock("./SidebarUserBar", () => ({ SidebarUserBar: () => null }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../AgentAvatar", () => ({ AgentAvatar: () => null }));
vi.mock("@/lib/api", () => ({ apiFetch: async () => ({ ok: true }) }));

import { ExplorerTree } from "./ExplorerTree";

type Agent = Parameters<typeof ExplorerTree>[0]["agents"][number];

const agent = (slug: string, unread: number): Agent => ({
  slug,
  department: "others",
  latest_run_started_at: null,
  latest_run_status: null,
  latest_event_preview: "",
  pending_decisions_count: 0,
  has_unseen_pending: false,
  unseen_thread_count: unread,
});

const render = (agents: Agent[]) =>
  renderToStaticMarkup(<ExplorerTree agents={agents} />);

describe("sidebar agent unread marker", () => {
  it("shows the bell when the agent has unread chats", () => {
    const html = render([agent("pm", 10)]);
    expect(html).toContain("has unread chats");
  });

  it("hides the marker entirely when the user is caught up (0 unread)", () => {
    const html = render([agent("pm", 0)]);
    expect(html).not.toContain("unread chats");
  });

  it("never renders the count — presence, not volume", () => {
    const html = render([agent("pm", 10)]);
    expect(html).not.toContain("10 unread");
    expect(html).not.toContain(">10<");
  });

  it("does not compress a triple-digit backlog to 99+ — it shows no number at all", () => {
    const html = render([agent("pm", 137)]);
    expect(html).toContain("has unread chats");
    expect(html).not.toContain("99+");
    expect(html).not.toContain("137");
  });
});
