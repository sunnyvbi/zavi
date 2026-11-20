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
        id: "t-email",
        agent_slug: "operator",
        title: "Email Lookup Request for Hush",
        last_message_at: "2026-09-23T10:00:00Z",
        created_at: "2026-09-23T09:00:00Z",
        last_message: null,
        run_status: "done",
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

import { ContextPanel, HistoryStatusBadge } from "./ContextPanel";

const noop = () => {};

function currentRows(html: string): string[] {
  const rows: string[] = [];
  const re = /<button[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/button>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) rows.push(m[1].replace(/<[^>]+>/g, "").trim());
  return rows;
}

describe("Recent highlights the build you are in, not the chat bound into it", () => {
  it("lights only the build row when the Build tab holds a bound operator thread", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T10:05:00Z"));
    const html = renderToStaticMarkup(
      <ContextPanel
        onCollapse={noop}
        theme="system"
        onSetTheme={noop}
        chatFocus={false}
      />,
    );
    expect(html).toContain("Email Lookup Request for Hush");
    expect(html).toContain(
      'aria-label="Chat (new): Email Lookup Request for Hush"',
    );
    expect(html).toContain(
      'aria-label="Build: Web app for helping people with tinnitus"',
    );
    const lit = currentRows(html).filter((t) => !["Build", "Home"].includes(t));
    expect(lit).toEqual(["Web app for helping people with tinnitus"]);
    vi.useRealTimers();
  });
});

describe("Recent status badge", () => {
  it.each([
    ["running", null, "bg-marigold", "Working"],
    ["running", "publishing", "bg-marigold", "Publishing"],
    ["completed", null, "bg-emerald-500", "New"],
    ["completed", "ready", "bg-emerald-500", "Ready"],
    ["error", null, "bg-coral", "Failed"],
    ["error", "publish_failed", "bg-coral", "Not live"],
    ["error", "failed", "bg-coral", "Stopped"],
  ] as const)("renders %s (%s) with its colour and a word", (status, buildState, className, word) => {
    const html = renderToStaticMarkup(<HistoryStatusBadge status={status} buildState={buildState} />);
    expect(html).toContain(className);
    expect(html).toContain(`>${word}</span>`);
  });
});

describe("Recent selection reads differently from hover", () => {
  function rowTag(html: string, title: string): string {
    const re = new RegExp(`<button[^>]*aria-label="[^"]*: ${title}"[^>]*>[\\s\\S]*?</button>`);
    const m = re.exec(html);
    expect(m).not.toBeNull();
    return m![0];
  }
  function classOf(tag: string): string[] {
    return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
  }

  it("gives the open row a strong fill, weight and accent bar, and the other row only a faint hover", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T10:05:00Z"));
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    vi.useRealTimers();

    const selected = rowTag(html, "Web app for helping people with tinnitus");
    const other = rowTag(html, "Email Lookup Request for Hush");

    expect(selected).toMatch(/^<button[^>]*aria-current="page"/);
    const sel = classOf(selected);
    expect(sel).toEqual(expect.arrayContaining(["bg-ink/10", "font-medium", "text-ink"]));
    expect(sel).not.toContain("hover:bg-ink/[0.04]");
    expect(sel.some((c) => c.startsWith("hover:bg-") || c === "bg-bone")).toBe(false);
    expect(selected).toContain("data-recent-accent");

    expect(/^<button[^>]*aria-current=/.test(other)).toBe(false);
    const oth = classOf(other);
    expect(oth).toContain("hover:bg-ink/[0.04]");
    expect(oth).not.toContain("bg-ink/10");
    expect(oth).not.toContain("font-medium");
    expect(oth.some((c) => c.startsWith("hover:font-"))).toBe(false);
    expect(other).not.toContain("data-recent-accent");
  });

  it("keeps the Recent header flat on hover", () => {
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    const header = /<button[^>]*aria-label="(?:Collapse|Expand) recent"[^>]*>/.exec(html);
    expect(header).not.toBeNull();
    const cls = classOf(header![0]);
    expect(cls.some((c) => c.startsWith("hover:bg-"))).toBe(false);
    expect(cls).toContain("hover:text-ink");
  });
});
