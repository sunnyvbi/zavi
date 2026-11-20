// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));
vi.mock("../../Composer", () => ({ Composer: () => <textarea aria-label="Message" /> }));
vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({ ChatExpandButton: () => null, HEADER_CARD_SHADOW: "" }));
vi.mock("../../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({ userEmail: "founder@example.com", openTab: () => "t", role: "owner", seedComposer: vi.fn(), openAgentTab: vi.fn() }),
}));
vi.mock("@/lib/workspace/useAgentRun", () => ({ useAgentRun: () => ({ send: vi.fn(), inflight: false }) }));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: [{ id: "u1", role: "user", content: "Make the design less plain", created_at: "2026-10-06T10:00:00.000Z", run_id: "run-live" }],
    activityRows: [],
    activityByRun: new Map(),
    loading: false,
    errorMsg: null,
    activeRunId: "run-live",
    activeTrigger: "chat",
    activeRunStartedAt: "2026-10-06T10:00:01.000Z",
    activeRunTurnStartedAt: "2026-10-06T10:00:00.000Z",
    removeOptimisticUser: vi.fn(),
    appendOptimisticUser: vi.fn(() => "optimistic-1"),
    appendOptimisticSystem: vi.fn(),
    markRunStopped: vi.fn(),
    unmarkRunStopped: vi.fn(),
    refetch: vi.fn(),
  }),
}));

import { HomeChatPanel } from "./HomeChatPanel";

afterEach(cleanup);

function renderPanel(overrides: Partial<React.ComponentProps<typeof HomeChatPanel>> = {}) {
  return render(
    <HomeChatPanel
      greeting="Hello"
      pulse="Ready"
      suggestions={[]}
      expanded={false}
      onExpandedChange={() => {}}
      width={430}
      dragging={false}
      separatorProps={{} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"]}
      initialThreadId="thread-1"
      {...overrides}
    />,
  );
}

const zaviTiles = () => Array.from(document.querySelectorAll('img[src="/zavi-white.svg"]'));
const mascots = () => Array.from(document.querySelectorAll('img[src^="/mascots/"]'));

describe("the live turn in a Build chat wears Zavi's face", () => {
  it("shows the Zavi tile the Build replies use, not the mascot, while a change is getting started", async () => {
    renderPanel({ buildSessionId: "session-1", surface: "card", showThreadBar: false, showExpand: false });
    await screen.findByText("Getting started…");
    expect(zaviTiles()).toHaveLength(1);
    expect(mascots()).toHaveLength(0);
  });

  it("shows no face on the Home chat's live turn", async () => {
    renderPanel();
    await screen.findByText("Getting started…");
    expect(mascots()).toHaveLength(0);
    expect(zaviTiles()).toHaveLength(0);
  });
});
