// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CHANNELS, type Channel } from "@zavi/shared";
import { ChannelPanel } from "../ChannelPanel";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../../agent/ScheduleView", () => ({
  ScheduleView: () => <div data-testid="schedule-view" />,
}));

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () =>
        String(path).includes("/settings")
          ? { fields: {} }
          : String(path).includes("/snapshots")
            ? { snapshots: [] }
            : {
                actions: [],
                more: 0,
                store: "channel_actions",
                metrics: [],
                briefs: [],
                artifacts: [],
              },
    }),
  );
});

const channel = (slug: string) =>
  (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;

function mount(slug: string, over: Partial<ChannelDetail> = {}) {
  const detail: ChannelDetail = {
    channel: channel(slug),
    mode: "produce",
    connected: true,
    connectors: ["google_ads"],
    workState: "delivered",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
    ...over,
  };
  return render(
    <ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => {}} />,
  );
}

const MOVED = ["Your numbers", "People", "Your creators", "Schedule"] as const;
const FACTS = ["Account", "Last worked", "What changed", "Measured on"] as const;

describe("the Overview tab", () => {
  it("holds the numbers and the actions, and none of what moved to Settings", async () => {
    mount("google_ads");
    expect(await screen.findByTestId("channel-value-empty")).toBeTruthy();

    for (const heading of MOVED) {
      expect(screen.queryByText(heading), `"${heading}" is back on Overview`).toBeNull();
    }
    for (const label of FACTS) {
      expect(screen.queryByText(label), `the facts list is back on Overview`).toBeNull();
    }
    expect(screen.queryByTestId("channel-run-note")).toBeNull();
  });

  it("keeps the schedule reachable, one tab over", async () => {
    mount("google_ads");
    await screen.findByTestId("channel-value-empty");
    await userEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    expect(await screen.findByTestId("channel-run-note")).toBeTruthy();
  });
});

describe("the UGC hub (S5, D15)", () => {
  it("puts Your creators on Overview, under the actions, and not on Settings", async () => {
    mount("ugc");
    expect(await screen.findByText("Your creators")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    expect(screen.getByTestId("channel-tab-settings").textContent).not.toContain("Your creators");
    expect(screen.getByText("Your creators").closest("[hidden]")).not.toBeNull();
  });
});

describe("the paste block only claims Zavi cannot read the account when that is true", () => {
  const PASTE_LINE = /Zavi can't read this ad account/;

  it("is absent on a CONNECTED paid channel, on either tab", async () => {
    mount("google_ads");
    await screen.findByTestId("channel-value-empty");
    expect(screen.queryByText(PASTE_LINE)).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    await screen.findByTestId("channel-run-note");
    expect(screen.queryByText(PASTE_LINE)).toBeNull();
  });

  it("is on Settings when the account really is not connected", async () => {
    mount("google_ads", { connected: false });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByText(PASTE_LINE)).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    expect(await screen.findByText(PASTE_LINE)).toBeTruthy();
  });
});
