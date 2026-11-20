import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const data = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  uiFlags: undefined as undefined | Record<string, boolean>,
}));

const workspace = {
  tabs: [{ id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true }],
  activeTabId: "home-default",
  buildSessionId: null,
  tenantName: "Acme",
  openAgentTab: vi.fn(),
  openBuildTab: vi.fn(),
  openTab: vi.fn(),
  setActiveTab: vi.fn(),
  setTabThreadId: vi.fn(),
  treeAgents: [],
  supplyDemandEligible: false,
  userEmail: "qa@example.com",
  role: "owner",
  creditsRemaining: 100,
};

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({ HowZaviWorksModal: () => null, howZaviConnectDestination: vi.fn() }));
vi.mock("../useAgentThreads", () => ({
  useWorkspaceThreads: () => ({ loaded: true, threads: data.threads }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: null,
    sessions: data.sessions,
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: data.uiFlags,
  }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel } from "./ContextPanel";

const noop = () => {};

function recentRows(html: string): Array<{ label: string; dot: boolean; marigold: boolean }> {
  const out: Array<{ label: string; dot: boolean; marigold: boolean }> = [];
  const re = /<button[^>]*aria-label="((?:Chat|Build)[^"]*)"[^>]*>([\s\S]*?)<\/button>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ label: m[1]!, dot: /rounded-full bg-/.test(m[2]!), marigold: m[2]!.includes("bg-marigold") });
  return out;
}

function render(): ReturnType<typeof recentRows> {
  return recentRows(renderToStaticMarkup(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  data.threads = [
    {
      id: "t-old",
      agent_slug: "operator",
      title: "Pricing ideas",
      created_at: "2026-10-01T09:00:00Z",
      last_message_at: "2026-10-01T11:59:00Z",
      last_message: null,
      run_status: "running",
      presentation_status: "running",
    },
    {
      id: "t-build",
      agent_slug: "operator",
      title: "Is my booking form live?",
      created_at: "2026-10-01T10:30:00Z",
      last_message_at: "2026-10-01T10:31:00Z",
      last_message: null,
      run_status: "done",
    },
  ];
  data.sessions = [
    {
      id: "b-1",
      title: "Dog grooming site",
      request: "",
      state: "building",
      run_status: "active",
      created_at: "2026-10-01T10:00:00Z",
      last_activity_at: "2026-10-01T11:00:00Z",
      refine_count: 0,
      is_current: true,
      chat_thread_ids: ["t-build"],
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DEL-1323 B26/B36: Recent in the sidebar", () => {
  it("with the settings on: build chat folded, rows by creation, yellow only on the running build", () => {
    data.uiFlags = { chatThreadFollowsBuild: true, recentRowsStable: true, publishWaitsForApp: true, mobileActions: true, chipsWrapMobile: true };
    const rows = render();
    expect(rows.map((r) => r.label)).toEqual(["Build (working): Dog grooming site", "Chat: Pricing ideas"]);
    expect(rows[0]!.marigold).toBe(true);
    expect(rows[1]!.dot).toBe(false);
    expect(rows[1]!.marigold).toBe(false);
  });

  it("with the settings off: the build's chat is its own row and a streaming reply jumps to the top with a yellow dot", () => {
    data.uiFlags = undefined;
    const rows = render();
    expect(rows.map((r) => r.label)).toEqual([
      "Chat (working): Pricing ideas",
      "Build (working): Dog grooming site",
      "Chat: Is my booking form live?",
    ]);
    expect(rows[0]!.marigold).toBe(true);
  });
});
