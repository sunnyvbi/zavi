import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ flags: undefined as Record<string, boolean> | undefined }));

const workspace = {
  tabs: [
    { id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true },
  ],
  activeTabId: "home-default",
  buildSessionId: null,
  tenantName: "Apna Tutor",
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
  useWorkspaceThreads: () => ({
    loaded: true,
    threads: [
      {
        id: "t-chat",
        agent_slug: "operator",
        title: "Pricing question",
        last_message_at: "2026-10-01T10:00:00Z",
        created_at: "2026-10-01T09:00:00Z",
        last_message: null,
        run_status: "failed",
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "b-yoga",
    flags: h.flags,
    sessions: [
      {
        id: "b-yoga",
        title: "Build product: Apna Tutor — a yoga studio site",
        request: "a yoga studio site",
        state: "building",
        run_status: "active",
        created_at: "2026-10-01T09:50:00Z",
        last_activity_at: "2026-10-01T10:01:00Z",
        refine_count: 0,
        is_current: true,
        site: { hostname: "still-water-yoga-693dfbdb-bbbbbb.zaviagent.com", live_url: null, status: "building", name: "Still Water Yoga", repo: "Praxis-build/still-water-yoga-693dfbdb-bbbbbb" },
      },
      {
        id: "b-paws",
        title: "Build product: Apna Tutor — dog grooming",
        request: "dog grooming",
        state: "ready",
        run_status: "done",
        created_at: "2026-10-01T09:00:00Z",
        last_activity_at: "2026-10-01T09:58:00Z",
        refine_count: 0,
        is_current: true,
        site: { hostname: "paws-suds-693dfbdb-aaaaaa.zaviagent.com", live_url: "https://paws-suds-693dfbdb-aaaaaa.zaviagent.com", status: "live", name: "Paws & Suds", repo: "Praxis-build/paws-suds-693dfbdb-aaaaaa" },
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel } from "./ContextPanel";

const noop = () => {};

function html(): string {
  return renderToStaticMarkup(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
}

function badges(markup: string): string[] {
  return [...markup.matchAll(/data-history-status="[^"]+"[^>]*>(?:<span[\s\S]*?<\/span><\/span>)?([^<]+)</g)].map((m) => m[1]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:05:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DEL-1323 B34/B36: Recent names each site, and every status says what it means", () => {
  it("with the key on, site rows carry the site's name, each with a worded status badge", () => {
    h.flags = { siteNames: true, siteRepoChip: true, siteListDetails: true };
    const markup = html();
    expect(markup).toContain('aria-label="Build (working): Still Water Yoga"');
    expect(markup).toContain('aria-label="Build (live): Paws &amp; Suds"');
    expect(markup).not.toContain("Build product: Apna Tutor");
    expect(badges(markup).sort()).toEqual(["Failed", "Live", "Working"]);
  });

  it("with the key off (or an older backend), titles stay as the backend sends them", () => {
    h.flags = undefined;
    const markup = html();
    expect(markup).toContain("Build product: Apna Tutor — a yoga studio site");
    expect(markup).not.toContain("Still Water Yoga");
  });
});
