import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const workspace = {
  tabs: [
    {
      id: "home-default",
      kind: "home",
      title: "Home",
      payload: { kind: "home" },
      dirty: false,
      pinned: true,
    },
    {
      id: "build-1",
      kind: "build",
      title: "Build",
      payload: { kind: "build", sessionId: "b-hush", threadId: "t-email" },
      dirty: false,
      pinned: false,
    },
  ],
  activeTabId: "build-1",
  buildSessionId: "b-hush",
  tenantName: "UpcarAI",
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
  tenantId: "t1",
};

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({
  HowZaviWorksModal: () => null,
  howZaviConnectDestination: vi.fn(),
}));
vi.mock("../useAgentThreads", () => ({
  useWorkspaceThreads: () => ({
    loaded: true,
    threads: [
      {
        id: "t-meta",
        agent_slug: "performance-marketer",
        title: "Meta this week",
        last_message_at: "2026-09-23T10:00:00Z",
        created_at: "2026-09-23T09:00:00Z",
        last_message: null,
        run_status: "done",
        presentation_status: "answered",
        unread: true,
        unread_reply: { head: "## Done\n\n**41 bookings** for $1,240. Cost per booking fell 9%.", kind: "reply", at: "2026-09-23T10:00:00Z" },
      },
      {
        id: "t-ask",
        agent_slug: "cgo",
        title: "Google budget raise",
        last_message_at: "2026-09-23T09:50:00Z",
        created_at: "2026-09-23T09:00:00Z",
        last_message: null,
        run_status: "done",
        presentation_status: "answered",
        unread: true,
        unread_reply: { head: "Which campaign should get it? I see two.", kind: "question", at: "2026-09-23T09:50:00Z" },
      },
      {
        id: "t-read",
        agent_slug: "operator",
        title: "Old chat",
        last_message_at: "2026-09-23T08:00:00Z",
        created_at: "2026-09-23T07:00:00Z",
        last_message: null,
        run_status: "done",
        presentation_status: "answered",
        unread: false,
        unread_reply: null,
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "b-hush",
    sessions: [
      {
        id: "b-hush",
        title: "Web app for helping people with tinnitus",
        request: "Create a web app for helping people with tinnitus",
        state: "ready",
        run_status: "done",
        created_at: "2026-09-23T08:00:00Z",
        last_activity_at: "2026-09-23T09:30:00Z",
        refine_count: 1,
        is_current: true,
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  prefetchChatThread: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));
vi.mock("@/lib/workspace/needsYou", async (actual) => ({
  ...(await actual<typeof import("@/lib/workspace/needsYou")>()),
  useNeedsYouSnapshot: () => ({ tenantId: "t1", decisions: [], totals: { needs_you: 4, growth: 0, channel: 0 }, loaded: true }),
}));

import { ContextPanel } from "./ContextPanel";

const noop = () => {};

function rowTag(html: string, title: string): string {
  const re = new RegExp(`<button[^>]*aria-label="[^"]*: ${title}[^"]*"[^>]*>[\\s\\S]*?</button>`);
  const m = re.exec(html);
  expect(m).not.toBeNull();
  return m![0];
}

function render() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  const html = renderToStaticMarkup(
    <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
  );
  vi.useRealTimers();
  return html;
}

describe("Recent: an unseen reply stays one line, bold with a dot", () => {
  it("bolds the row and adds a dot, with no preview line and no New pill", () => {
    const row = rowTag(render(), "Meta this week");
    expect(row).toContain("font-semibold");
    expect(row).toMatch(/data-unread-reply="reply"[^>]*bg-ink/);
    expect(row).not.toContain("line-clamp");
    expect(row).not.toContain("flex-col");
    expect(row).not.toContain(">New</span>");
  });

  it("stays bold past the 15-minute pill TTL: it follows the server unread bit", () => {
    expect(rowTag(render(), "Meta this week")).toContain("data-unread-reply");
  });

  it("gives a question an amber dot and says so in the tooltip", () => {
    const row = rowTag(render(), "Google budget raise");
    expect(row).toMatch(/data-unread-reply="question"[^>]*bg-\[#b7791f\]/);
    expect(row).toMatch(/title="Google budget raise\n[^"]*needs your answer: Which campaign should get it\?/);
  });

  it("reads the reply in the row's accessible name", () => {
    expect(render()).toMatch(/aria-label="Chat \(unread\): Meta this week\. [^"]+: 41 bookings for \$1,240\."/);
  });

  it("leaves a read chat plain", () => {
    const row = rowTag(render(), "Old chat");
    expect(row).not.toContain("data-unread-reply");
    expect(row).not.toContain("font-semibold");
  });

  it("shows the Needs you row next to the bell beside the workspace name", () => {
    const html = render();
    expect(html).toContain(">Needs you<");
    expect(html).toContain("data-needs-you-count");
    expect(html).toMatch(/aria-label="Notifications \(1 waiting on you\)"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain("data-notifications-dot");
  });
});
