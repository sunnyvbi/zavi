// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

vi.mock("./ChannelPanel", () => ({ ChannelPanel: () => <div data-testid="channel-panel" /> }));

import { ChannelDetailPage, type ChannelDetail } from "./ChannelDrawer";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "../actions/channelPlanLock";

afterEach(cleanup);

const seo = (CHANNELS as readonly Channel[]).find((c) => c.slug === "seo")!;
const detail: ChannelDetail = {
  channel: seo,
  mode: "produce",
  connected: false,
  connectors: [],
  workState: "delivered",
  lastRunAt: null,
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};

const page = (lock: ChannelPlanLock | null) =>
  render(
    <ChannelPlanLockProvider value={lock}>
      <ChannelDetailPage detail={detail} actionCount={0} error={null} onClose={() => {}} onOpenConnectors={() => {}} />
    </ChannelPlanLockProvider>,
  );

describe("the plan line under a channel's header", () => {
  it("says what the drafts are for and links to the plan", () => {
    const upgrade = vi.fn();
    page({ tierName: "Starter", upgrade });
    const line = screen.getByTestId("plan-lock-line");
    expect(line.textContent).toBe(
      "These drafts are yours to read and use. Zavi posting for you is on Starter. See Starter",
    );
    fireEvent.click(within(line).getByRole("button", { name: "See Starter" }));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("channel-panel")).toBeTruthy();
  });

  it("names the plan the lock names", () => {
    page({ tierName: "Pro", upgrade: () => {} });
    expect(screen.getByTestId("plan-lock-line").textContent).toContain("Zavi posting for you is on Pro. See Pro");
  });

  it("is absent on an open channel, with or without a gate", () => {
    page({ tierName: null, upgrade: () => {} });
    expect(screen.queryByTestId("plan-lock-line")).toBeNull();
    cleanup();
    page(null);
    expect(screen.queryByTestId("plan-lock-line")).toBeNull();
  });
});
