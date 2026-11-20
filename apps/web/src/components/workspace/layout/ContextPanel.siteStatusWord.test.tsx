import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const sessions = [
  {
    id: "b-paws",
    title: "Booking website for my dog grooming salon",
    request: "Booking website for my dog grooming salon",
    state: "ready",
    run_status: "done",
    created_at: "2026-10-05T08:00:00Z",
    last_activity_at: "2026-10-05T09:58:00Z",
    refine_count: 0,
    is_current: true,
    site: { hostname: "paws-suds.zavi.site", live_url: "https://paws-suds.zavi.site", status: "live", name: "Paws & Suds" },
  },
  {
    id: "b-draft",
    title: "Bakery menu site",
    request: "Bakery menu site",
    state: "ready",
    run_status: "done",
    created_at: "2026-10-05T07:00:00Z",
    last_activity_at: "2026-10-05T09:57:00Z",
    refine_count: 0,
    is_current: true,
    site: { hostname: "crumbs.zavi.site", live_url: null, status: "building", name: "Crumbs" },
  },
  {
    id: "b-old",
    title: "Tinnitus helper",
    request: "Tinnitus helper",
    state: "ready",
    run_status: "done",
    created_at: "2026-10-05T06:00:00Z",
    last_activity_at: "2026-10-05T09:56:00Z",
    refine_count: 0,
    is_current: true,
  },
];

const workspace = {
  tabs: [{ id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true }],
  activeTabId: "home-default",
  buildSessionId: null,
  tenantName: "Paws",
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
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ loaded: true, threads: [] }) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "b-paws",
    sessions,
    flags: { siteNames: true, siteRepoChip: true, siteListDetails: true },
  }),
  readBuildSessions: () => ({ loaded: true, currentSessionId: "b-paws", sessions }),
  refreshBuildSessions: vi.fn(async () => {}),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(), apiUrl: (p: string) => p }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel } from "./ContextPanel";
import { RecentBuilds } from "../build/BuildModePane";
import type { BuildSessionMeta } from "@/lib/workspace/buildHistory";

const noop = () => {};

function recentWord(html: string, title: string): string | null {
  const re = new RegExp(`aria-label="Build(?: \\(([^)]*)\\))?: ${title.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}"`);
  const m = re.exec(html.replace(/&amp;/g, "&"));
  if (!m) throw new Error(`no Recent row for ${title}`);
  return m[1] ?? null;
}

function badgeText(html: string, title: string): string {
  const flat = html.replace(/&amp;/g, "&");
  const at = flat.indexOf(`title="${title}"`);
  const button = flat.slice(at, flat.indexOf("</button>", at));
  const m = /data-history-status="[^"]+"[^>]*>([\s\S]*?)<\/span>$/.exec(button);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function yourSitesBadges(): Record<string, string> {
  const html = renderToStaticMarkup(
    <RecentBuilds sessions={sessions as BuildSessionMeta[]} currentSessionId="b-paws" onOpen={noop} siteNames />,
  ).replace(/&amp;/g, "&");
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/data-site-badge="([^"]+)"[\s\S]*?<span class="truncate">([^<]+)<\/span>/g)) out[m[2]] = m[1];
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("l4.10: Recent says the same status word as Your sites", () => {
  it("a published site reads Live in Recent, matching its Your sites card, and a built-not-published one matches too", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    const cards = yourSitesBadges();
    expect(cards["paws-suds.zavi.site"]).toBe("Live");
    expect(cards["crumbs.zavi.site"]).toBe("Not published");

    expect(recentWord(html, "Paws & Suds")).toBe("live");
    expect(badgeText(html, "Paws & Suds")).toBe(cards["paws-suds.zavi.site"]);
    expect(recentWord(html, "Crumbs")).toBe("not published");
    expect(badgeText(html, "Crumbs")).toBe(cards["crumbs.zavi.site"]);
    expect(html).not.toMatch(/data-history-status="completed"[^>]*bg-emerald-500[^>]*>Not published/);

    expect(recentWord(html, "Tinnitus helper")).toBe("ready");
  });
});
