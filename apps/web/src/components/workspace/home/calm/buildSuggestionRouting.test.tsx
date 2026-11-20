// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";

const composer = vi.hoisted(() => ({
  beforeSend: undefined as undefined | ((message: string) => Promise<{ handled: boolean }>),
}));

vi.mock("../../Composer", () => ({
  Composer: (props: { onBeforeSend?: typeof composer.beforeSend }) => {
    composer.beforeSend = props.onBeforeSend;
    return <textarea aria-label="Message" />;
  },
}));
vi.mock("../../ChatThread", () => ({ ChatThread: () => <div /> }));
vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({ ChatExpandButton: () => null }));
vi.mock("../../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: [],
    activityRows: [],
    activityByRun: new Map(),
    loading: false,
    errorMsg: null,
    activeRunId: null,
    activeTrigger: null,
    activeRunStartedAt: null,
    activeRunTurnStartedAt: null,
    removeOptimisticUser: vi.fn(),
    appendOptimisticUser: vi.fn(() => "optimistic-1"),
    appendOptimisticSystem: vi.fn(),
    markRunStopped: vi.fn(),
    unmarkRunStopped: vi.fn(),
    refetch: vi.fn(),
  }),
}));

import { HomeChatPanel } from "./HomeChatPanel";

afterEach(() => {
  cleanup();
  composer.beforeSend = undefined;
});

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
      composerSuggestions={[
        {
          key: "pricing",
          label: "Add pricing section",
          prompt: "Create a pricing table or cards section.",
        },
      ]}
      {...overrides}
    />,
  );
}

describe("Build suggestion routing", () => {
  it("preserves suggestion provenance through Send", async () => {
    const generic = vi.fn(async () => ({ handled: false }));
    const refine = vi.fn(async () => ({ handled: true, consumed: true }));
    renderPanel({ onBeforeSend: generic, onBuildSuggestionSend: refine });

    fireEvent.click(screen.getByRole("button", { name: "Add pricing section" }));
    const out = await composer.beforeSend?.("Create a pricing table or cards section.");

    expect(refine).toHaveBeenCalledWith("Create a pricing table or cards section.");
    expect(generic).not.toHaveBeenCalled();
    expect(out).toMatchObject({ handled: true });
  });

  it("does not force unrelated replacement text into the build refine path", async () => {
    const generic = vi.fn(async () => ({ handled: false }));
    const refine = vi.fn(async () => ({ handled: true }));
    renderPanel({ onBeforeSend: generic, onBuildSuggestionSend: refine });

    fireEvent.click(screen.getByRole("button", { name: "Add pricing section" }));
    await composer.beforeSend?.("What does this page say?");

    expect(generic).toHaveBeenCalledWith("What does this page say?");
    expect(refine).not.toHaveBeenCalled();
  });
});
