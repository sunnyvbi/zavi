// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const workspace = {
  tabs: [{ id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true }],
  activeTabId: "home-default",
  tenantName: "UpcarAI",
  openAgentTab: vi.fn(),
  openBuildTab: vi.fn(),
  openTab: vi.fn(),
  treeAgents: [],
  supplyDemandEligible: false,
  userEmail: "qa@example.com",
  role: "owner",
  creditsRemaining: 100,
};

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({
  HowZaviWorksModal: () => null,
  howZaviConnectDestination: vi.fn(),
}));
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ threads: [], loaded: false }) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ useBuildSessions: () => ({ sessions: [], loaded: false }) }));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));

vi.mock("./workspacePrefs", () => ({
}));

import { ContextPanel, ContextRail } from "./ContextPanel";

const noop = () => {};

afterEach(cleanup);

const ORDER = [
  "Home",
  "Growth Channels",
  "Analytics",
  "Messaging",
  "Build",
  "Artifacts",
  "Connectors",
];

describe("left nav (#18)", () => {
  it("expanded panel: Board leaves the destinations, with no Onboarding row", () => {
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    expect(html).not.toContain(">Board<");
    expect(html).not.toContain("Onboarding");
  });

  it("expanded panel: destinations in order, Home first", () => {
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    const positions = ORDER.map((label) => html.indexOf(`>${label}<`));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("expanded panel: Your CGO leads the menu, above Home, and Growth Strategy is gone", () => {
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    const cgo = html.indexOf(">Your CGO<");
    expect(cgo).toBeGreaterThan(-1);
    expect(cgo).toBeLessThan(html.indexOf(">Home<"));
    expect(html).not.toContain(">Growth Strategy<");
    expect(html).toContain('src="/mascots/video/zavi-still.webp"');
  });

  it("collapsed rail: Your CGO is the first icon", () => {
    const html = renderToStaticMarkup(<ContextRail onExpand={noop} chatFocus={false} />);
    const cgo = html.indexOf('aria-label="Your CGO"');
    expect(cgo).toBeGreaterThan(-1);
    expect(cgo).toBeLessThan(html.indexOf('aria-label="Home"'));
    expect(html).not.toContain('aria-label="Growth Strategy"');
  });

  it("collapsed rail: no Onboarding, same order as the panel", () => {
    const html = renderToStaticMarkup(<ContextRail onExpand={noop} chatFocus={false} />);
    expect(html).not.toContain("Onboarding");
    expect(html).not.toContain('aria-label="Board"');
    const positions = ORDER.map((label) => html.indexOf(`aria-label="${label}"`));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("agent pages carry the backend's plan lock and lose it when unlocked", () => {
    const render = () =>
      renderToStaticMarkup(
        <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
      );
    const rail = () => renderToStaticMarkup(<ContextRail onExpand={noop} chatFocus={false} />);

    workspace.treeAgents = [
      { slug: "fundraising", locked_tier: "pro" },
      { slug: "engineer", locked_tier: "pro" },
    ] as never;
    const html = render();
    expect(html.match(/\(Pro plan\)/g)).toHaveLength(2);
    expect(html).toContain(">Fundraising<");
    const railHtml = rail();
    expect(railHtml).toContain('aria-label="Engineer (Pro plan)"');
    expect(railHtml).toContain('aria-label="Fundraising (Pro plan)"');

    workspace.treeAgents = [
      { slug: "fundraising", locked_tier: null },
      { slug: "engineer", locked_tier: null },
    ] as never;
    expect(render()).not.toContain("Pro plan");
    expect(rail()).toContain('aria-label="Engineer"');

    workspace.treeAgents = [];
  });
});

describe("a plan-locked agent page in the nav", () => {
  afterEach(() => {
    workspace.treeAgents = [];
    workspace.role = "owner";
    workspace.openTab.mockClear();
    vi.useRealTimers();
    window.location.hash = "";
  });

  it("opens the plan picker preselected on Pro for an owner, not the locked page", () => {
    vi.useFakeTimers();
    workspace.treeAgents = [{ slug: "fundraising", locked_tier: "pro" }] as never;
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Fundraising/ }));
    expect(workspace.openTab).toHaveBeenCalledTimes(1);
    expect(workspace.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    vi.advanceTimersByTime(100);
    expect(window.location.hash).toBe("#billing-upgrade-pro-6mo");
  });

  it("does the same from the collapsed rail", () => {
    vi.useFakeTimers();
    workspace.treeAgents = [{ slug: "engineer", locked_tier: "pro" }] as never;
    render(<ContextRail onExpand={noop} chatFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Engineer (Pro plan)" }));
    expect(workspace.openTab.mock.calls[0]![0]).toMatchObject({ kind: "settings" });
    vi.advanceTimersByTime(100);
    expect(window.location.hash).toBe("#billing-upgrade-pro-6mo");
  });

  it("still opens the page itself for a member, who cannot upgrade", () => {
    workspace.role = "member";
    workspace.treeAgents = [{ slug: "fundraising", locked_tier: "pro" }] as never;
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Fundraising/ }));
    expect(workspace.openTab.mock.calls[0]![0]).toMatchObject({ kind: "fundraising" });
    expect(window.location.hash).toBe("");
  });

  it("opens the page when it is not locked", () => {
    workspace.treeAgents = [{ slug: "fundraising", locked_tier: null }] as never;
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Fundraising/ }));
    expect(workspace.openTab.mock.calls[0]![0]).toMatchObject({ kind: "fundraising" });
  });
});

describe("account menu", () => {
  it("opens Board from the profile dropdown", () => {
    workspace.openTab.mockClear();
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);

    expect(screen.queryByRole("menuitem", { name: "Board" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = screen.getByRole("menu", { name: "Account" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Board" }));

    expect(workspace.openTab).toHaveBeenCalledWith({
      kind: "home",
      title: "360 View",
      payload: { kind: "home" },
      dirty: false,
      pinned: true,
    });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("carries no How Zavi works entry, while Help and Feedback stay", () => {
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(within(menu).queryByRole("menuitem", { name: /how zavi works/i })).toBeNull();
    expect(within(menu).queryByText(/how zavi works/i)).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Feedback" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Help" })).toBeTruthy();
  });
});

describe("Send feedback in the sidebar", () => {
  it("is a row of its own that opens the feedback window with the form and Your requests", () => {
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    const row = screen.getByRole("button", { name: "Send feedback" });
    expect(row.hasAttribute("disabled")).toBe(false);
    fireEvent.click(row);
    expect(screen.getByRole("heading", { name: "Send feedback" })).toBeTruthy();
    expect(screen.getByLabelText("Your feedback")).toBeTruthy();
    expect(screen.getByText("Your requests")).toBeTruthy();
  });
});

describe("Tutorials in the sidebar", () => {
  it("is a new-tab link to the tutorials page, just above Send feedback", () => {
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    const link = screen.getByRole("link", { name: /^Tutorials/ });
    expect(link.getAttribute("href")).toBe("/tutorials");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toContain("(opens in a new tab)");
    const feedback = screen.getByRole("button", { name: "Send feedback" });
    expect(link.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the Hide sidebar control on a phone", () => {
  it("grows to the 44px tap target inside the compact sheet, and stays 32px on desktop", () => {
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    const match = /<button[^>]*aria-label="Hide sidebar"[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/.exec(html);
    expect(match).not.toBeNull();
    const cls = match![1].split(" ");
    expect(cls).toContain("h-8");
    expect(cls).toContain("w-8");
    expect(cls).toContain("compact:h-11");
    expect(cls).toContain("compact:w-11");
    expect(match![2]).toContain("compact:h-5");
    expect(match![2]).toContain("compact:w-5");
  });
});

describe("the destination rows on a phone", () => {
  it("draws in full ink on a phone and near-black inkSoft on desktop", () => {
    const html = renderToStaticMarkup(
      <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />,
    );
    const buttons = html.split("<button").slice(1);
    for (const label of ORDER) {
      const row = buttons.find((b) => b.includes(`>${label}<`));
      expect(row, label).toBeTruthy();
      const cls = /^[^>]*class="([^"]*)"/.exec(row!)?.[1].split(" ") ?? [];
      expect(cls, label).toContain("text-inkSoft");
      expect(cls, label).toContain("compact:text-ink");
      expect(row, label).toContain('class="text-inkSoft compact:text-ink"');
    }
  });
});
