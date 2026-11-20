// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const sessionsState = vi.hoisted(() => ({
  value: { sessions: [] as unknown[], currentSessionId: null as string | null, loaded: true },
}));

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ seedComposer: vi.fn(), openBuildTab: vi.fn(), treeAgents: [{ slug: "engineer", locked_tier: null }] }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => sessionsState.value,
}));
vi.mock("../ConnectRows", () => ({ ConnectRows: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("../CreditWallNotice", () => ({ CreditWallNotice: () => null }));

import { ExistingProductPane } from "./ExistingProductPane";

afterEach(() => {
  cleanup();
  sessionsState.value = { sessions: [], currentSessionId: null, loaded: true };
});

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  request: "",
  state: "ready",
  run_status: "done",
  created_at: "2026-09-30T01:00:00Z",
  last_activity_at: "2026-09-30T01:00:00Z",
  refine_count: 0,
  is_current: false,
  ...extra,
});

describe("Your builds: new-flow sites", () => {
  it("two live sites each show their own address and a Live badge; an old build shows neither", () => {
    sessionsState.value = {
      currentSessionId: null,
      loaded: true,
      sessions: [
        row("Alpha", { site: { hostname: "alpha.zaviagent.com", live_url: "https://alpha.zaviagent.com", status: "live" } }),
        row("Beta", { site: { hostname: "beta.zaviagent.com", live_url: "https://beta.zaviagent.com", status: "live" } }),
        row("Old"),
      ],
    };
    render(<ExistingProductPane />);
    const items = within(screen.getByLabelText("Your builds")).getAllByRole("listitem");
    expect(within(items[0]).getByText("alpha.zaviagent.com")).toBeTruthy();
    expect(within(items[0]).getByRole("link", { name: "Open Alpha in a new tab" }).getAttribute("href")).toBe("https://alpha.zaviagent.com");
    expect(within(items[1]).getByRole("link", { name: "Open Beta in a new tab" }).getAttribute("href")).toBe("https://beta.zaviagent.com");
    expect(items[0].querySelector("[data-site-badge]")?.textContent).toBe("Live");
    expect(items[2].querySelector("[data-site-badge]")).toBeNull();
    expect(within(items[2]).queryByRole("link")).toBeNull();
    expect(within(items[0]).getAllByRole("button")).toHaveLength(1);
  });

  it("a building or paused site shows its badge and no link until live", () => {
    sessionsState.value = {
      currentSessionId: null,
      loaded: true,
      sessions: [
        row("Gamma", { state: "building", site: { hostname: "gamma.zaviagent.com", live_url: null, status: "building" } }),
        row("Delta", { site: { hostname: "delta.zaviagent.com", live_url: "https://delta.zaviagent.com", status: "paused" } }),
      ],
    };
    render(<ExistingProductPane />);
    const items = within(screen.getByLabelText("Your builds")).getAllByRole("listitem");
    expect(items[0].querySelector("[data-site-badge]")?.textContent).toBe("Building");
    expect(within(items[0]).queryByRole("link")).toBeNull();
    expect(items[1].querySelector("[data-site-badge]")?.textContent).toBe("Paused");
  });
});
