// @vitest-environment jsdom
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
      payload: { kind: "build", sessionId: "b-hush", threadId: "t-other" },
      dirty: false,
      pinned: false,
    },
  ],
  activeTabId: "build-1",
  buildSessionId: "b-hush",
  tenantName: "Yoga Studio",
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
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel, ContextRail } from "./ContextPanel";
import { HistoryRowMenu } from "./HistoryRowMenu";

const noop = () => {};

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

function panel(): Document {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T10:05:00Z"));
  const html = renderToStaticMarkup(
    <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
  );
  vi.useRealTimers();
  return parse(html);
}

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function navButton(doc: Document, label: string): HTMLElement {
  const nav = doc.querySelector('nav[aria-label="Destinations"]')!;
  const hit = Array.from(nav.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(hit, `nav item ${label}`).toBeTruthy();
  return hit as HTMLElement;
}

function fillAtRest(cls: string[]): string[] {
  return cls.filter((c) => /^bg-/.test(c));
}

function fillUnderPointer(cls: string[]): string[] {
  const hover = cls.filter((c) => c.startsWith("hover:bg-")).map((c) => c.slice("hover:".length));
  return hover.length > 0 ? hover : fillAtRest(cls);
}

describe("main nav selection reads differently from hover", () => {
  it("selected Build and a hovered Artifacts never show the same pill", () => {
    const doc = panel();
    const build = navButton(doc, "Build");
    const artifacts = navButton(doc, "Artifacts");
    expect(build.getAttribute("aria-current")).toBe("page");
    expect(artifacts.getAttribute("aria-current")).toBeNull();

    const selectedFill = fillUnderPointer(classes(build));
    const hoveredFill = fillUnderPointer(classes(artifacts));
    expect(selectedFill).toEqual(["bg-ink/10"]);
    expect(hoveredFill).toEqual(["bg-ink/[0.04]"]);
    expect(selectedFill).not.toEqual(hoveredFill);
    expect(fillAtRest(classes(artifacts))).toEqual([]);
  });

  it("marks only the selected row with medium weight, full ink and a 2px accent bar", () => {
    const doc = panel();
    const nav = doc.querySelector('nav[aria-label="Destinations"]')!;
    const build = navButton(doc, "Build");
    const artifacts = navButton(doc, "Artifacts");
    expect(classes(build)).toEqual(expect.arrayContaining(["font-medium", "text-ink"]));
    expect(classes(build)).not.toContain("text-inkSoft");
    expect(classes(artifacts)).toContain("text-inkSoft");
    expect(classes(artifacts)).toContain("hover:text-ink");

    expect(nav.querySelectorAll("[data-nav-accent]")).toHaveLength(0);
    expect(Array.from(build.children).some((c) => /\bw-\[[23]px\]/.test(c.getAttribute("class") ?? ""))).toBe(false);
    expect(classes(build)).toEqual(expect.arrayContaining(["bg-ink/10"]));
  });

  it("keeps a gap between nav items so adjacent pills do not touch", () => {
    const nav = panel().querySelector('nav[aria-label="Destinations"]')!;
    expect(classes(nav).some((c) => /^(gap-|space-y-)/.test(c) && !/-0$/.test(c))).toBe(true);
  });

  it("collapsed rail: the current icon and a hovered icon get different fills", () => {
    const doc = parse(renderToStaticMarkup(<ContextRail onExpand={noop} chatFocus={false} />));
    const build = doc.querySelector('button[aria-label="Build"]')!;
    const artifacts = doc.querySelector('button[aria-label="Artifacts"]')!;
    expect(build.getAttribute("aria-current")).toBe("page");
    const selectedFill = fillUnderPointer(classes(build));
    const hoveredFill = fillUnderPointer(classes(artifacts));
    expect(selectedFill).toEqual(["bg-ink/10"]);
    expect(hoveredFill).toEqual(["bg-ink/[0.04]"]);
  });
});

describe("Recent list spacing", () => {
  it("separates every row from the next so the selected and hovered pills never touch", () => {
    const doc = panel();
    const selected = doc.querySelector(
      'button[aria-label="Build: Web app for helping people with tinnitus"]',
    )!;
    const chat = doc.querySelector('button[aria-label^="Chat"][aria-label$="Email Lookup Request for Hush"]')!;
    expect(selected).toBeTruthy();
    expect(chat).toBeTruthy();
    const list = selected.parentElement!;
    expect(list.contains(chat)).toBe(true);
    const listGap = classes(list).some((c) => /^(gap-|gap-y-|space-y-)/.test(c) && !/-0$/.test(c));
    const rowMargin = [selected, chat.parentElement!].every((r) =>
      classes(r).some((c) => /^(my-|mt-|mb-)/.test(c) && !/-0$/.test(c)),
    );
    expect(listGap || rowMargin).toBe(true);
  });

  it("reserves room on the right of a hovered row for the bare three-dot icon", () => {
    const doc = panel();
    const chat = doc.querySelector('button[aria-label^="Chat"][aria-label$="Email Lookup Request for Hush"]')!;
    expect(chat.parentElement!.querySelector('button[aria-label="More options"]')).toBeTruthy();
    expect(classes(chat)).toEqual(
      expect.arrayContaining(["group-hover/row:pr-8", "group-focus-within/row:pr-8"]),
    );
  });
});

describe("Recent row three-dot button", () => {
  it("shows only the icon: no fill at rest or on hover, colour change only", () => {
    const doc = parse(renderToStaticMarkup(<HistoryRowMenu onRename={noop} onDelete={noop} />));
    const more = doc.querySelector('button[aria-label="More options"]')!;
    const cls = classes(more);
    expect(cls.filter((c) => /(^|:)bg-/.test(c))).toEqual([]);
    expect(cls.filter((c) => /^rounded/.test(c))).toEqual([]);
    expect(cls).toContain("text-inkLight");
    expect(cls).toContain("hover:text-ink");
  });
});

describe("Recent New Chat button", () => {
  it("is a round, square-sized hit target whose hover fill is a circle", () => {
    const doc = panel();
    const plus = doc.querySelector('button[aria-label="New Chat"]')!;
    const cls = classes(plus);
    expect(cls).toContain("rounded-full");
    expect(cls.filter((c) => /^rounded/.test(c))).toEqual(["rounded-full"]);
    const h = cls.find((c) => /^h-\d/.test(c))?.slice(2);
    const w = cls.find((c) => /^w-\d/.test(c))?.slice(2);
    expect(h).toBeDefined();
    expect(h).toBe(w);
    expect(Number(h)).toBeGreaterThanOrEqual(6);
    expect(cls.some((c) => c.startsWith("hover:bg-"))).toBe(true);
  });
});
