// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const openBuildTab = vi.hoisted(() => vi.fn());
const seedComposer = vi.hoisted(() => vi.fn());
const sessionsState = vi.hoisted(() => ({
  value: { sessions: [] as unknown[], currentSessionId: null as string | null, loaded: true },
}));

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ seedComposer, openBuildTab, treeAgents: [{ slug: "engineer", locked_tier: null }] }),
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
  openBuildTab.mockClear();
  seedComposer.mockClear();
  sessionsState.value = { sessions: [], currentSessionId: null, loaded: true };
});

describe("ExistingProductPane recent builds", () => {
  it("opens a past build in the Build tab without seeding the engineer chat", () => {
    sessionsState.value = {
      currentSessionId: "b1",
      loaded: true,
      sessions: [
        { id: "b1", title: "Try again", request: "", state: "failed", run_status: "halted", created_at: "2026-09-22T13:42:36Z", last_activity_at: "2026-09-22T14:36:07Z", refine_count: 0, is_current: true },
        { id: "b2", title: "HandyHub", request: "", state: "ready", run_status: "done", created_at: "2026-09-11T06:33:09Z", last_activity_at: "2026-09-11T07:18:01Z", refine_count: 0, is_current: false },
      ],
    };
    render(<ExistingProductPane />);
    const section = screen.getByLabelText("Your builds");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    fireEvent.click(within(items[1]).getByRole("button"));
    expect(openBuildTab).toHaveBeenCalledWith("b2");
    expect(seedComposer).not.toHaveBeenCalled();
  });

  it("shows nothing for a tenant with no builds", () => {
    render(<ExistingProductPane />);
    expect(screen.queryByLabelText("Your builds")).toBeNull();
  });
});
